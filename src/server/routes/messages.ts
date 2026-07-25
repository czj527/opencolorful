import type { Hono } from "hono";

import type { RuntimePaths } from "../../config/paths.js";
import type { AgentStore } from "../../config/agent-store.js";
import { createApiError } from "../../contracts/api-error.js";
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

      if (!promptService.hasRuntime(sessionId)) {
        if (!sessionService || !paths) {
          return context.json(createApiError("CONFLICT", "Session Runtime 未就绪"), 409);
        }
        try {
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

          // 构建 Agent 人设 system prompt（仅当会话绑定了 Agent 且 profile 存在时）
          const systemPrompt = view.agentId ? buildSystemPrompt(view.agentId) : undefined;

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
        } catch {
          return context.json(createApiError("SESSION_ERROR", "无法创建 Session Runtime"), 500);
        }
      } else {
        // Runtime 已存在：检查 Agent profile 是否有更新，如有则重建 runtime
        const view = sessionService?.getView(sessionId);
        if (view?.agentId && agentStore) {
          const currentPrompt = buildSystemPrompt(view.agentId);
          const lastPrompt = runtimeSystemPrompt.get(sessionId);
          if (currentPrompt !== lastPrompt) {
            // profile 已更新，使旧 runtime 失效，下次循环会重建
            promptService.invalidate(sessionId);
            runtimeSystemPrompt.delete(sessionId);
            // 重新创建
            try {
              const session = sessionService!.open(sessionId);
              const toolMode = (view.toolMode ?? "off") as ToolMode;
              const toolPolicy = new ToolPolicy();
              const tools = toolPolicy.resolveTools(
                toolMode,
                view.workspaceCwd ?? undefined,
                view.workspaceConfirmed,
              );
              const noTools = toolPolicy.shouldDisableAllTools(toolMode) ? ("all" as const) : undefined;
              const runtimeCwd = view.workspaceCwd || process.cwd();
              const selectedModel = session.model;
              if (selectedModel && modelService && selectedModel.providerId !== "faux") {
                const runtime = await SessionRuntime.create({
                  sessionId,
                  cwd: runtimeCwd,
                  authPath: paths!.authFile,
                  publish: () => {},
                  sessionHandle: session,
                  modelService,
                  resolveProviderId: selectedModel.providerId,
                  resolveModelId: selectedModel.modelId,
                  ...(noTools ? { noTools } : {}),
                  ...(tools.length > 0 && !noTools ? { tools } : {}),
                  thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
                  ...(currentPrompt ? { systemPrompt: currentPrompt } : {}),
                  ...(replayStore ? { replayStore } : {}),
                });
                promptService.register(runtime);
                runtimeSystemPrompt.set(sessionId, currentPrompt);
              } else {
                const runtime = await SessionRuntime.create({
                  sessionId,
                  cwd: process.cwd(),
                  sessionDir: paths!.sessions,
                  authPath: paths!.authFile,
                  providerId: "faux",
                  modelId: "faux-1",
                  faux: { response: "已收到您的消息", tokensPerSecond: 20 },
                  publish: () => {},
                  sessionHandle: session,
                  ...(noTools ? { noTools } : {}),
                  ...(tools.length > 0 && !noTools ? { tools } : {}),
                  thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
                  ...(currentPrompt ? { systemPrompt: currentPrompt } : {}),
                  ...(replayStore ? { replayStore } : {}),
                });
                promptService.register(runtime);
                runtimeSystemPrompt.set(sessionId, currentPrompt);
              }
            } catch {
              return context.json(createApiError("SESSION_ERROR", "无法重建 Session Runtime"), 500);
            }
          }
        }
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
    if (!promptService.hasRuntime(sessionId)) {
      return context.json(createApiError("NOT_FOUND", "Session Runtime 不存在"), 404);
    }
    try {
      await promptService.compact(sessionId);
      return context.json({ status: "completed" });
    } catch {
      return context.json(createApiError("CONFLICT", "当前会话无需压缩"), 409);
    }
  });
}
