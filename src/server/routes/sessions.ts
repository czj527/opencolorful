import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { SessionService } from "../../runtime/session-service.js";

export function registerSessionRoutes(app: Hono, sessionService: SessionService): void {
  app.get("/api/sessions", (context) => context.json(sessionService.list()));

  app.post("/api/sessions", async (context) => {
    const body = (await context.req.json()) as { title?: unknown; cwd?: unknown };
    if (typeof body.title !== "string" || typeof body.cwd !== "string" || !body.cwd.trim()) {
      return context.json(createApiError("INVALID_INPUT", "Session title 和 cwd 必须是字符串"), 400);
    }
    const session = sessionService.create({ title: body.title, cwd: body.cwd });
    return context.json(sessionService.getView(session.id), 201);
  });

  app.get("/api/sessions/:id", (context) => {
    try {
      return context.json(sessionService.getView(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.delete("/api/sessions/:id", (context) => {
    try {
      return context.json(sessionService.archive(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });
}
