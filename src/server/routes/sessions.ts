import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import {
  parseSessionSettings,
  SessionSettingsValidationError,
} from "../../contracts/session-settings.js";
import type { SessionService } from "../../runtime/session-service.js";

export function registerSessionRoutes(app: Hono, sessionService: SessionService): void {
  app.get("/api/sessions", (context) => context.json(sessionService.list()));

  app.post("/api/sessions", async (context) => {
    const body = (await context.req.json()) as {
      title?: unknown;
      cwd?: unknown;
      toolMode?: unknown;
      workspaceCwd?: unknown;
      workspaceConfirmed?: unknown;
    };
    if (typeof body.title !== "string" || typeof body.cwd !== "string" || !body.cwd.trim()) {
      return context.json(createApiError("INVALID_INPUT", "Session title 和 cwd 必须是字符串"), 400);
    }
    const session = sessionService.create({ title: body.title, cwd: body.cwd });

    // 可选：创建时设置工具模式
    if (typeof body.toolMode === "string" || typeof body.workspaceCwd === "string") {
      try {
        const settings = parseSessionSettings({
          ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
          ...(typeof body.workspaceCwd === "string" ? { cwd: body.workspaceCwd } : {}),
          ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
        });
        sessionService.updateSettings(session.id, {
          ...(settings.toolMode ? { toolMode: settings.toolMode } : {}),
          ...(settings.cwd ? { workspaceCwd: settings.cwd } : {}),
          ...(settings.workspaceConfirmed !== undefined ? { workspaceConfirmed: settings.workspaceConfirmed } : {}),
        });
      } catch (error) {
        return context.json(
          createApiError(
            "INVALID_INPUT",
            error instanceof SessionSettingsValidationError ? error.message : "设置无效",
          ),
          400,
        );
      }
    }

    return context.json(sessionService.getView(session.id), 201);
  });

  app.get("/api/sessions/:id", (context) => {
    try {
      return context.json(sessionService.getView(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.put("/api/sessions/:id/model", async (context) => {
    try {
      const body = (await context.req.json()) as { providerId?: unknown; modelId?: unknown };
      if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
        return context.json(createApiError("INVALID_INPUT", "providerId 和 modelId 不能为空"), 400);
      }
      const session = sessionService.open(context.req.param("id"));
      session.selectModel(body.providerId, body.modelId);
      return context.json(sessionService.getView(session.id));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.put("/api/sessions/:id/settings", async (context) => {
    try {
      const sessionId = context.req.param("id");
      const body = (await context.req.json()) as Record<string, unknown>;
      try {
        parseSessionSettings(body);
      } catch (error) {
        return context.json(
          createApiError(
            "INVALID_INPUT",
            error instanceof SessionSettingsValidationError ? error.message : "设置无效",
          ),
          400,
        );
      }

      // 目录变更时，若未显式确认，自动清除旧确认
      const currentView = sessionService.getView(sessionId);
      const newCwd = typeof body.workspaceCwd === "string" ? body.workspaceCwd : undefined;
      const explicitConfirmed = "workspaceConfirmed" in body;
      const cwdChanged = newCwd !== undefined && newCwd !== currentView.workspaceCwd;
      if (cwdChanged && !explicitConfirmed && typeof body.toolMode === "string" && body.toolMode === "all") {
        return context.json(
          createApiError("INVALID_INPUT", "更改工作目录后必须重新确认 all 模式"),
          400,
        );
      }

      const updated = sessionService.updateSettings(sessionId, {
        ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
        ...(typeof body.workspaceCwd === "string" ? { workspaceCwd: body.workspaceCwd } : {}),
        ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
      });
      return context.json(updated);
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
