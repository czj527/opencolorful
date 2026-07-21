import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import { createSessionEventStream } from "../sse/session-events.js";

export function registerEventRoutes(
  app: Hono,
  replayStore: EventReplayStore,
  promptService: PromptService,
  sessionService?: SessionService,
): void {
  app.get("/api/sessions/:id/events", async (context) => {
    const sessionId = context.req.param("id");
    // 校验 Session 在索引中存在
    if (sessionService) {
      try {
        sessionService.getView(sessionId);
      } catch {
        return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
      }
    }
    return createSessionEventStream(context, sessionId, replayStore, promptService);
  });
}
