import type { Hono, Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { createApiError, type ApiError } from "../../contracts/api-error.js";
import { SessionBranchError } from "../../contracts/session-branch.js";
import { EnsureRuntimeError, type RuntimeBootstrap } from "./runtime-bootstrap.js";

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
 *
 * 波次 B2 修复：Runtime 懒创建复用共享 bootstrap（runtime-bootstrap.ts，与
 * messages 路由同一实例）——插件/Skill/Subagent/记忆/人设工具面与 profile/
 * 插件签名重建逻辑与 messages 路径完全一致，杜绝分支路由首次动作触发静默
 * 降级装配。
 */

export interface SessionBranchRoutesOptions {
  readonly sessionService: import("../../runtime/session-service.js").SessionService;
  readonly promptService: import("../../runtime/prompt-service.js").PromptService;
  /** 共享 Runtime Bootstrap（app 组合根构造的单例，与 registerMessageRoutes 同实例） */
  readonly runtimeBootstrap: RuntimeBootstrap;
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
  const { sessionService, promptService, runtimeBootstrap } = options;

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
        // 共享 bootstrap：懒创建/按需重建（含插件/Skill/记忆/人设全量装配）
        await runtimeBootstrap.ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
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
        // 共享 bootstrap：切换前确保 Runtime 就绪（全量工具面装配）
        await runtimeBootstrap.ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
        }
        throw error;
      }
      return context.json(promptService.switchBranch(sessionId, body.branchId));
    } catch (error) {
      return jsonError(context, error, "分支切换失败");
    }
  });
}
