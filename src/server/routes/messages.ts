import type { Hono } from "hono";

import type { RuntimePaths } from "../../config/paths.js";
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
}

export function registerMessageRoutes(app: Hono, options: MessageRoutesOptions): void {
  const { promptService, sessionService, replayStore, paths, modelService } = options;

  app.post("/api/sessions/:id/messages", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json()) as { content?: unknown };
      if (typeof body.content !== "string" || !body.content.trim()) {
        return context.json(createApiError("INVALID_INPUT", "Prompt 不能为空"), 400);
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

          // 如果 session 选择了模型且有 modelService，使用真实模型
          const selectedModel = session.model;
          if (selectedModel && modelService && selectedModel.providerId !== "faux") {
            const runtime = await SessionRuntime.create({
              sessionId,
              cwd: process.cwd(),
              authPath: paths.authFile,
              publish: () => {},
              sessionHandle: session,
              modelService,
              resolveProviderId: selectedModel.providerId,
              resolveModelId: selectedModel.modelId,
              ...(noTools ? { noTools } : {}),
              ...(tools.length > 0 && !noTools ? { tools } : {}),
              ...(replayStore ? { replayStore } : {}),
            });
            promptService.register(runtime);
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
              ...(replayStore ? { replayStore } : {}),
            });
            promptService.register(runtime);
          }
        } catch {
          return context.json(createApiError("SESSION_ERROR", "无法创建 Session Runtime"), 500);
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
}
