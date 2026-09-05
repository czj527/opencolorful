import type { Hono, Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AgentStore } from "../../config/agent-store.js";
import type { RuntimePaths } from "../../config/paths.js";
import { createApiError, type ApiError } from "../../contracts/api-error.js";
import type { ToolMode } from "../../contracts/session-settings.js";
import { SessionBranchError } from "../../contracts/session-branch.js";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import { SessionRuntime } from "../../runtime/session-runtime.js";
import { ToolPolicy } from "../../runtime/tool-policy.js";
import type Database from "better-sqlite3";

/**
 * 波次 B2：会话分支 / 重生成 / Fork 路由（plans/p1-conversation-workbench.en.md §3.3/§3.4）。
 *
 * - GET  /api/sessions/:id/tree            分支树视图（叶子枚举，元数据+短预览）
 * - GET  /api/sessions/:id/entries?branch= 分支条目视图（根→叶 + turnId 分组）
 * - POST /api/sessions/:id/regenerate      edit-and-retry 统一重生成 → 202
 * - POST /api/sessions/:id/fork            Fork 成独立会话 → 201
 * - POST /api/sessions/:id/branch/switch   切换当前分支 → 200
 *
 * 错误矩阵（B0 §3.4 冻结）：busy → 409 SESSION_BUSY；引用节点不存在 → 404
 * NOT_FOUND；输入不合法/空源 → 400 INVALID_INPUT；已归档 → 409 CONFLICT。
 */

export interface SessionBranchRoutesOptions {
  readonly sessionService: SessionService;
  readonly promptService: PromptService;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly replayStore?: EventReplayStore;
  readonly database?: Database.Database;
  readonly agentStore?: AgentStore;
}

interface MappedError {
  readonly status: ContentfulStatusCode;
  readonly body: ApiError;
}

function mapBranchError(error: unknown): MappedError | undefined {
  if (!(error instanceof SessionBranchError)) return undefined;
  switch (error.code) {
    case "not_found":
      return { status: 404, body: createApiError("NOT_FOUND", "引用的会话节点不存在，请刷新后重试") };
    case "invalid_input":
      return { status: 400, body: createApiError("INVALID_INPUT", error.message) };
    case "busy":
      return { status: 409, body: createApiError("SESSION_BUSY", "会话正在运行，请先停止后再操作") };
    case "conflict":
      return { status: 409, body: createApiError("CONFLICT", error.message) };
  }
}

function mapUnexpected(error: unknown, message: string): MappedError {
  // 不回传内部错误细节（可能含路径/Provider 信息），稳定中文文案
  void error;
  return { status: 500, body: createApiError("INTERNAL_ERROR", message) };
}

/** 统一错误映射：SessionBranchError 按矩阵映射；其余稳定 500 文案 */
function errorResponse(error: unknown, unexpectedMessage: string): MappedError {
  return mapBranchError(error) ?? mapUnexpected(error, unexpectedMessage);
}

function jsonError(context: Context, error: unknown, unexpectedMessage: string): Response {
  const mapped = errorResponse(error, unexpectedMessage);
  return context.json(mapped.body, mapped.status);
}

export function registerSessionBranchRoutes(app: Hono, options: SessionBranchRoutesOptions): void {
  const { sessionService, promptService } = options;

  class EnsureRuntimeFailure extends Error {
    constructor(readonly mapped: MappedError) {
      super(mapped.body.message);
    }
  }

  /**
   * 懒创建 Runtime（分支操作在会话未加载时也可执行）。
   *
   * 这是 messages.ts ensureRuntime 的核心子集：工具模式解析、faux/真实模型
   * 解析、思维级别、工作区、replayStore 与 Agent 归属一致；插件/Skill/
   * Subagent 工具与沙箱上下文不在此复制——绑定 Agent 的会话在下一次用户
   * 消息时会因 profile/插件签名失配被 messages.ts 自动重建（自愈），无 Agent
   * 会话无这些工具面。偏离已在 B2 报告中记录。
   */
  async function ensureRuntime(sessionId: string): Promise<void> {
    if (promptService.hasRuntime(sessionId)) return;
    const { paths, modelService } = options;
    if (!paths) {
      throw new EnsureRuntimeFailure({
        status: 409,
        body: createApiError("CONFLICT", "Session Runtime 未就绪"),
      });
    }    try {
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
      const noTools = toolPolicy.shouldDisableAllTools(toolMode) ? ("all" as const) : undefined;
      const tools = fileTools.length > 0 ? [...fileTools] : undefined;
      const selectedModel = session.model;
      if (modelService !== undefined && selectedModel === null) {
        throw new EnsureRuntimeFailure({
          status: 409,
          body: createApiError("CONFLICT", "当前 Session 未选择主对话模型，请先配置默认模型或显式选择模型"),
        });
      }
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
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(options.replayStore ? { replayStore: options.replayStore } : {}),
          workspaceCwd: view.workspaceCwd,
        });
        promptService.register(runtime);
        return;
      }
      const runtime = await SessionRuntime.create({
        sessionId,
        cwd: runtimeCwd,
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
        thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        ...(options.replayStore ? { replayStore: options.replayStore } : {}),
        workspaceCwd: view.workspaceCwd,
      });
      promptService.register(runtime);
    } catch (error) {
      if (error instanceof EnsureRuntimeFailure) throw error;
      throw new EnsureRuntimeFailure({
        status: 409,
        body: createApiError("CONFLICT", "Session Runtime 未就绪"),
      });
    }
  }

  // ── 分支树视图 ──────────────────────────────────────────────────────
  app.get("/api/sessions/:id/tree", (context) => {
    try {
      return context.json(sessionService.getTree(context.req.param("id")));
    } catch (error) {
      return jsonError(context, error, "分支树读取失败");
    }
  });

  // ── 分支条目视图 ────────────────────────────────────────────────────
  app.get("/api/sessions/:id/entries", (context) => {
    try {
      const branchId = context.req.query("branchId");
      return context.json(
        sessionService.getEntries(
          context.req.param("id"),
          branchId === undefined || branchId === "" ? undefined : branchId,
        ),
      );
    } catch (error) {
      return jsonError(context, error, "分支条目读取失败");
    }
  });

  // ── 重生成（edit-and-retry 统一原语）────────────────────────────────
  app.post("/api/sessions/:id/regenerate", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json()) as { targetEntryId?: unknown; text?: unknown };
      if (typeof body.targetEntryId !== "string" || !body.targetEntryId) {
        return context.json(createApiError("INVALID_INPUT", "targetEntryId 不能为空"), 400);
      }
      if (typeof body.text !== "string" || !body.text.trim()) {
        return context.json(createApiError("INVALID_INPUT", "重生成内容不能为空"), 400);
      }
      const view = sessionService.getView(sessionId);
      if (view.archived) {
        return context.json(createApiError("CONFLICT", "会话已归档"), 409);
      }
      try {
        await ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeFailure) {
          return context.json(error.mapped.body, error.mapped.status);
        }
        throw error;
      }
      const run = await promptService.regenerate(sessionId, body.targetEntryId, body.text);
      return context.json(
        {
          status: "accepted",
          sessionId,
          streamId: run.streamId,
          branchId: run.branchId,
        },
        202,
      );
    } catch (error) {
      return jsonError(context, error, "重新生成失败");
    }
  });

  // ── Fork 成独立会话 ─────────────────────────────────────────────────
  app.post("/api/sessions/:id/fork", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json().catch(() => ({}))) as { targetEntryId?: unknown };
      if (body.targetEntryId !== undefined && (typeof body.targetEntryId !== "string" || !body.targetEntryId)) {
        return context.json(createApiError("INVALID_INPUT", "targetEntryId 无效"), 400);
      }
      if (promptService.isBusy(sessionId)) {
        return context.json(createApiError("SESSION_BUSY", "会话正在运行，请先停止后再操作"), 409);
      }
      const created = sessionService.forkSession(
        sessionId,
        typeof body.targetEntryId === "string" ? body.targetEntryId : undefined,
      );
      // 源会话流广播 branches.changed{fork}（源 runtime 未加载时 no-op）
      promptService.emitBranchesChanged(sessionId, "fork");
      return context.json(created, 201);
    } catch (error) {
      return jsonError(context, error, "Fork 失败");
    }
  });

  // ── 切换当前分支 ────────────────────────────────────────────────────
  app.post("/api/sessions/:id/branch/switch", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json()) as { branchId?: unknown };
      if (typeof body.branchId !== "string" || !body.branchId) {
        return context.json(createApiError("INVALID_INPUT", "branchId 不能为空"), 400);
      }
      const view = sessionService.getView(sessionId);
      if (view.archived) {
        return context.json(createApiError("CONFLICT", "会话已归档"), 409);
      }
      if (promptService.isBusy(sessionId)) {
        return context.json(createApiError("SESSION_BUSY", "会话正在运行，请先停止后再操作"), 409);
      }
      try {
        await ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeFailure) {
          return context.json(error.mapped.body, error.mapped.status);
        }
        throw error;
      }
      return context.json(promptService.switchBranch(sessionId, body.branchId));
    } catch (error) {
      return jsonError(context, error, "分支切换失败");
    }
  });
}
