import type { Hono } from "hono";

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

export interface MessageRoutesOptions {
  readonly promptService: PromptService;
  readonly sessionService?: SessionService;
  readonly replayStore?: EventReplayStore;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly agentStore?: AgentStore;
}

// ensureRuntime 的失败结果：路由层直接转成对应状态码
class EnsureRuntimeError extends Error {
  constructor(readonly apiError: ApiError, readonly status: 409 | 500) {
    super(apiError.message);
  }
}

export function registerMessageRoutes(app: Hono, options: MessageRoutesOptions): void {
  const { promptService, sessionService, replayStore, paths, modelService, agentStore } = options;

  // 跟踪每个 session 运行时使用的 systemPrompt，用于检测 profile 更新
  const runtimeSystemPrompt = new Map<string, string | undefined>();

  function buildSystemPrompt(agentId: string): string | undefined {
    if (agentStore === undefined) return undefined;
    const profile = agentStore.getProfile(agentId);
    if (profile === null) return undefined;
    const parts: string[] = [];
    if (profile.persona) {
      parts.push(profile.persona);
    }
    if (profile.replyStyle) {
      parts.push(`回复风格: ${profile.replyStyle}`);
    }
    if (profile.personality.length > 0) {
      parts.push(`性格标签: ${profile.personality.join("、")}`);
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
      const tools = toolPolicy.resolveTools(
        toolMode,
        view.workspaceCwd ?? undefined,
        view.workspaceConfirmed,
      );
      const noTools = toolPolicy.shouldDisableAllTools(toolMode) ? ("all" as const) : undefined;
      const runtimeCwd = view.workspaceCwd || process.cwd();

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
          ...(noTools ? { noTools } : {}),
          ...(tools.length > 0 && !noTools ? { tools } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
        });
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
          ...(noTools ? { noTools } : {}),
          ...(tools.length > 0 && !noTools ? { tools } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
        });
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
