import type { Hono } from "hono";
import * as path from "node:path";

import type { RuntimePaths } from "../../config/paths.js";
import type { AgentStore } from "../../config/agent-store.js";
import { createApiError, type ApiError } from "../../contracts/api-error.js";
import type { ToolMode } from "../../contracts/session-settings.js";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import { SessionRuntime } from "../../runtime/session-runtime.js";
import { ToolPolicy } from "../../runtime/tool-policy.js";
import { buildMemoryInjectionBlock } from "../../runtime/memory/memory-injection.js";
import { MemoryRecallService } from "../../runtime/memory/recall-service.js";
import { MemoryFactStore } from "../../storage/memory/fact-store.js";
import { MemoryEventStore } from "../../storage/memory/event-store.js";
import { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import { PinnedMemoryStore } from "../../storage/memory/pinned-store.js";
import { SessionIndex } from "../../storage/session-index.js";
import { registerMemoryContext } from "../../pi-sdk/memory-tools.js";
import { MEMORY_TOOL_NAMES } from "../../pi-sdk/agent-session.js";
import type Database from "better-sqlite3";

export interface MessageRoutesOptions {
  readonly promptService: PromptService;
  readonly sessionService?: SessionService;
  readonly replayStore?: EventReplayStore;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly agentStore?: AgentStore;
  readonly database?: Database.Database;
}

// ensureRuntime 的失败结果：路由层直接转成对应状态码
class EnsureRuntimeError extends Error {
  constructor(readonly apiError: ApiError, readonly status: 409 | 500) {
    super(apiError.message);
  }
}

export function registerMessageRoutes(app: Hono, options: MessageRoutesOptions): void {
  const { promptService, sessionService, replayStore, paths, modelService, agentStore, database } = options;

  // 跟踪每个 session 运行时使用的 systemPrompt（含记忆块 revision），用于检测 profile/memory 更新
  const runtimeSystemPrompt = new Map<string, string | undefined>();

  /** 构建含记忆注入的完整 system prompt。未绑定 Agent 或不具备记忆条件时仅返回 persona。 */
  function buildSystemPrompt(agentId: string): string | undefined {
    if (agentStore === undefined) return undefined;
    const baseColor = agentStore.getBaseColor(agentId);
    const parts: string[] = [];
    if (baseColor.persona) {
      parts.push(baseColor.persona);
    }
    if (baseColor.replyStyle) {
      parts.push(`回复风格: ${baseColor.replyStyle}`);
    }
    if (baseColor.personality.length > 0) {
      parts.push(`性格标签: ${baseColor.personality.join("、")}`);
    }
    if (baseColor.innerSetting) {
      parts.push(`相处边界: ${baseColor.innerSetting}`);
    }

    // 记忆注入：在 persona 之后追加
    if (paths && database) {
      const memoryDir = path.join(paths.agents, agentId, "memory");
      const pinnedStore = new PinnedMemoryStore(database);
      const pinned = pinnedStore.listByAgent(agentId);
      const injection = buildMemoryInjectionBlock({ memoryDir, pinned });
      if (injection) {
        parts.push(injection.block);
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  // 懒重建 runtime：无 runtime 时按 messages 路由同款逻辑创建；
  // 已有 runtime 且 Agent profile 变更时先 invalidate 再重建。
  // 失败抛 EnsureRuntimeError，由调用方映射为 HTTP 响应。
  async function ensureRuntime(sessionId: string): Promise<void> {
    const createRuntime = async (systemPrompt: string | undefined) => {
      // 仅在需要创建/重建 runtime 时才要求 sessionService 与 paths 存在
      if (!sessionService || !paths) {
        throw new EnsureRuntimeError(createApiError("CONFLICT", "Session Runtime 未就绪"), 409);
      }
      const session = sessionService.open(sessionId);
      const view = sessionService.getView(sessionId);
      const toolMode = (view.toolMode ?? "off") as ToolMode;
      const toolPolicy = new ToolPolicy();
      const fileTools = toolPolicy.resolveTools(
        toolMode,
        view.workspaceCwd ?? undefined,
        view.workspaceConfirmed,
      );
      const runtimeCwd = view.workspaceCwd || process.cwd();

      // 记忆工具：Agent 绑定 + 数据库可用时始终启用
      const hasMemoryTools = !!(view.agentId && database);
      const extraTools = hasMemoryTools ? [...MEMORY_TOOL_NAMES] : undefined;
      // 有记忆工具时决不使用 noTools: "all"
      const noTools = (toolPolicy.shouldDisableAllTools(toolMode) && !hasMemoryTools)
        ? ("all" as const)
        : undefined;
      const tools = fileTools.length > 0 ? [...fileTools] : undefined;

      // 构建沙箱上下文：当 session 绑定 Agent 且 paths/agentStore 可用时
      let agentSettings: import("../../contracts/agent-settings.js").AgentSettingsV2 | undefined;
      let agentHomeDir: string | undefined;
      let platformHome: string | undefined;
      if (view.agentId && agentStore && paths) {
        try {
          agentSettings = agentStore.getSettings(view.agentId);
          agentHomeDir = path.join(paths.agents, view.agentId);
          platformHome = paths.home;
        } catch {
          // 读取 Agent 设置失败时降级运行，不启用沙箱
        }
      }

      // 构建记忆层上下文（在 runtime 创建后注册）
      let unregisterMemory: (() => void) | undefined;
      const setupMemoryContext = (runtime: SessionRuntime) => {
        if (!database || !view.agentId || !paths) return;
        try {
          const factStore = new MemoryFactStore(database);
          const eventStore = new MemoryEventStore(database);
          const recallStore = new MemoryRecallStore(database);
          const journalStore = new MemoryJournalStore(database);
          const pinnedStore = new PinnedMemoryStore(database);
          const sessionIndex = new SessionIndex(database);

          const recallService = new MemoryRecallService({
            factStore,
            eventStore,
            recallStore,
            sessionIndex,
            publish: (env) => {
              if (replayStore) replayStore.publish(env);
            },
            agentsDir: paths.agents,
          });

          unregisterMemory = registerMemoryContext(sessionId, {
            agentId: view.agentId!,
            recallService,
            journalStore,
            pinnedStore,
          });
        } catch {
          // 记忆层初始化失败不阻塞会话创建
        }
      };

      // 如果 session 选择了模型且有 modelService，使用真实模型
      const selectedModel = session.model;
      if (selectedModel && modelService && selectedModel.providerId !== "faux") {
        const runtime = await SessionRuntime.create({
          sessionId,
          cwd: runtimeCwd,
          authPath: paths.authFile,
          publish: () => {},
          sessionHandle: session,
          modelService,
          resolveProviderId: selectedModel.providerId,
          resolveModelId: selectedModel.modelId,
          ...(view.agentId != null ? { agentId: view.agentId } : {}),
          ...(noTools ? { noTools } : {}),
          ...(tools ? { tools } : {}),
          ...(extraTools ? { extraTools } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
          ...(agentSettings ? { agentSettings } : {}),
          ...(agentHomeDir ? { agentHomeDir } : {}),
          ...(platformHome ? { platformHome } : {}),
          workspaceCwd: view.workspaceCwd,
          onDispose: () => unregisterMemory?.(),
        });
        setupMemoryContext(runtime);
        promptService.register(runtime);
        runtimeSystemPrompt.set(sessionId, systemPrompt);
      } else {
        const runtime = await SessionRuntime.create({
          sessionId,
          cwd: process.cwd(),
          sessionDir: paths.sessions,
          authPath: paths.authFile,
          providerId: "faux",
          modelId: "faux-1",
          faux: { response: "已收到您的消息", tokensPerSecond: 20 },
          publish: () => {},
          sessionHandle: session,
          ...(view.agentId != null ? { agentId: view.agentId } : {}),
          ...(noTools ? { noTools } : {}),
          ...(tools ? { tools } : {}),
          ...(extraTools ? { extraTools } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
          ...(agentSettings ? { agentSettings } : {}),
          ...(agentHomeDir ? { agentHomeDir } : {}),
          ...(platformHome ? { platformHome } : {}),
          workspaceCwd: view.workspaceCwd,
          onDispose: () => unregisterMemory?.(),
        });
        setupMemoryContext(runtime);
        promptService.register(runtime);
        runtimeSystemPrompt.set(sessionId, systemPrompt);
      }
    };

    if (!promptService.hasRuntime(sessionId)) {
      // 对齐原 messages 路由：无 runtime 且缺少 sessionService/paths 时直接 409
      if (!sessionService || !paths) {
        throw new EnsureRuntimeError(createApiError("CONFLICT", "Session Runtime 未就绪"), 409);
      }
      try {
        const view = sessionService.getView(sessionId);
        // 构建 Agent 人设 system prompt（仅当会话绑定了 Agent 且 profile 存在时）
        const systemPrompt = view.agentId ? buildSystemPrompt(view.agentId) : undefined;
        await createRuntime(systemPrompt);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) throw error;
        throw new EnsureRuntimeError(createApiError("SESSION_ERROR", "无法创建 Session Runtime"), 500);
      }
      return;
    }

    // Runtime 已存在：检查 Agent profile 是否有更新，如有则重建 runtime
    const view = sessionService?.getView(sessionId);
    if (view?.agentId && agentStore) {
      const currentPrompt = buildSystemPrompt(view.agentId);
      const lastPrompt = runtimeSystemPrompt.get(sessionId);
      if (currentPrompt !== lastPrompt) {
        // profile 已更新，使旧 runtime 失效并重建
        promptService.invalidate(sessionId);
        runtimeSystemPrompt.delete(sessionId);
        try {
          await createRuntime(currentPrompt);
        } catch (error) {
          if (error instanceof EnsureRuntimeError) throw error;
          throw new EnsureRuntimeError(createApiError("SESSION_ERROR", "无法重建 Session Runtime"), 500);
        }
      }
    }
  }

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

      try {
        await ensureRuntime(sessionId);
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
        await ensureRuntime(sessionId);
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
