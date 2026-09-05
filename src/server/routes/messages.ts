import type { Hono } from "hono";

import type { RuntimePaths } from "../../config/paths.js";
import type { AgentStore } from "../../config/agent-store.js";
import { createApiError } from "../../contracts/api-error.js";
import type { MemoryAgentSettings } from "../../contracts/memory.js";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import type { PluginFacade } from "../../platform/plugin-facade.js";
import type Database from "better-sqlite3";

// 波次 B2 修复：Runtime 装配全量逻辑抽取到共享模块（runtime-bootstrap.ts），
// 由组合根构造单例后同时供 messages 路由与会话分支路由使用。本文件保留的
// 生产接线导出（buildPluginSessionTools/buildPluginTurnSnapshotFactory）改为
// 从共享模块转发，既有测试导入路径不变。
export {
  buildPluginSessionTools,
  buildPluginTurnSnapshotFactory,
  createRuntimeBootstrap,
  EnsureRuntimeError,
} from "./runtime-bootstrap.js";
export type { RuntimeBootstrap, RuntimeBootstrapOptions } from "./runtime-bootstrap.js";

import {
  createRuntimeBootstrap,
  EnsureRuntimeError,
  type RuntimeBootstrap,
} from "./runtime-bootstrap.js";

export interface MessageRoutesOptions {
  readonly promptService: PromptService;
  readonly sessionService?: SessionService;
  readonly replayStore?: EventReplayStore;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly agentStore?: AgentStore;
  readonly database?: Database.Database;
  /**
   * 记忆设置解析（评审 P1#7b：injectBudgetChars 必须接真实设置）。
   * 与 start.ts resolveMemorySettings 同一优先级：per-Agent 覆盖 → 全局默认 → 平台默认。
   * 未提供时按平台默认（buildMemoryInjectionBlock 的默认预算）。
   */
  readonly memorySettingsResolver?: (agentId: string) => MemoryAgentSettings;
  /** Phase 12：插件组合根（绑定 Agent 的插件工具注入主会话） */
  readonly pluginFacade?: PluginFacade;
  /** Phase 13 T6：Skill Core Service（注入后 Agent 会话启用 search_skills 等五个 Core 工具） */
  readonly skillCoreService?: import("../../runtime/skills/core/skill-core-service.js").SkillCoreService;
  /** Phase 14 T6：Subagent 运行时组合根（注入后主会话启用七个 Core 工具；缺省不注册，§20.2） */
  readonly subagent?: { readonly composition?: import("../../runtime/subagents/composition.js").SubagentRuntimeComposition };
  /**
   * 波次 B2 修复：共享 Runtime Bootstrap（组合根注入的单例，与分支路由共用）。
   * 未注入时由本路由 options 现场构造（直接调用本路由的测试路径，行为不变）。
   */
  readonly runtimeBootstrap?: RuntimeBootstrap;
}

export function registerMessageRoutes(app: Hono, options: MessageRoutesOptions): void {
  const { promptService, sessionService } = options;

  // 波次 B2 修复：Runtime 装配（ensureRuntime + profile/插件签名跟踪 Map）整体
  // 迁移到共享 bootstrap；组合根注入的单例优先（与分支路由同实例），直接调用
  // 本路由的测试路径回退到按本 options 构造（原闭包语义，行为不变）。
  const bootstrap = options.runtimeBootstrap ?? createRuntimeBootstrap(options);

  app.post("/api/sessions/:id/messages", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json()) as { content?: unknown };
      if (typeof body.content !== "string" || !body.content.trim()) {
        return context.json(createApiError("INVALID_INPUT", "Prompt 不能为空"), 400);
      }
      if (sessionService !== undefined) {
        const view = sessionService.getView(sessionId);
        if (view.archived) {
          return context.json(createApiError("CONFLICT", "已归档 Session 不能执行 Prompt"), 409);
        }
      }
      const view = sessionService !== undefined ? sessionService.getView(sessionId) : undefined;

      try {
        await bootstrap.ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
        }
        throw error;
      }

      const run = promptService.prompt(sessionId, body.content);
      return context.json(
        {
          status: "accepted",
          sessionId,
          streamId: run.streamId,
        },
        202,
      );
    } catch {
      return context.json(createApiError("CONFLICT", "Session 当前无法接受 Prompt"), 409);
    }
  });

  app.post("/api/sessions/:id/abort", async (context) => {
    try {
      const body = (await context.req.json()) as { streamId?: unknown };
      if (typeof body.streamId !== "string") {
        return context.json(createApiError("INVALID_INPUT", "streamId 无效"), 400);
      }
      return context.json(promptService.abort(context.req.param("id"), body.streamId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session Runtime 不存在"), 404);
    }
  });

  app.post("/api/sessions/:id/compact", async (context) => {
    const sessionId = context.req.param("id");

    // 归档会话拒绝 compact（对齐 messages 路由的 archived 检查）
    if (sessionService !== undefined) {
      try {
        const view = sessionService.getView(sessionId);
        if (view.archived) {
          return context.json(createApiError("CONFLICT", "已归档 Session 不能压缩"), 409);
        }
      } catch {
        return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
      }
    }

    // 忙时拒绝：会话正在生成时返回 409 SESSION_BUSY
    if (promptService.isBusy(sessionId)) {
      return context.json(createApiError("SESSION_BUSY", "会话正在生成，无法压缩", false), 409);
    }

    // 无 runtime 时走与 messages 相同的懒重建
    if (!promptService.hasRuntime(sessionId)) {
      try {
        await bootstrap.ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
        }
        throw error;
      }
    }

    try {
      await promptService.compact(sessionId);
      return context.json({ status: "completed" });
    } catch {
      return context.json(createApiError("CONFLICT", "当前会话无需压缩"), 409);
    }
  });
}
