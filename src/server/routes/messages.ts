import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { PromptService } from "../../runtime/prompt-service.js";

export function registerMessageRoutes(app: Hono, promptService: PromptService): void {
  app.post("/api/sessions/:id/messages", async (context) => {
    try {
      const body = (await context.req.json()) as { content?: unknown };
      if (typeof body.content !== "string" || !body.content.trim()) {
        return context.json(createApiError("INVALID_INPUT", "Prompt 不能为空"), 400);
      }
      const run = promptService.prompt(context.req.param("id"), body.content);
      return context.json(
        {
          status: "accepted",
          sessionId: context.req.param("id"),
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
