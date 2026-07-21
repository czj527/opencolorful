import type { Hono } from "hono";

import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import { createSessionEventStream } from "../sse/session-events.js";

export function registerEventRoutes(
  app: Hono,
  replayStore: EventReplayStore,
  promptService: PromptService,
): void {
  app.get("/api/sessions/:id/events", async (context) => {
    return createSessionEventStream(
      context,
      context.req.param("id"),
      replayStore,
      promptService,
    );
  });
}
