import type { Hono } from "hono";
import path from "node:path";

import { createApiError } from "../../contracts/api-error.js";
import {
  parseSessionSettings,
  SessionSettingsValidationError,
} from "../../contracts/session-settings.js";
import type { SessionService } from "../../runtime/session-service.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { PreferencesStore } from "../../config/preferences-store.js";
import type { AgentStore } from "../../config/agent-store.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerSessionRoutes(
  app: Hono,
  sessionService: SessionService,
  modelService?: ModelService,
  promptService?: PromptService,
  preferencesStore?: PreferencesStore,
  agentStore?: AgentStore,
): void {
  app.get("/api/sessions", (context) => {
    const includeArchived = context.req.query("includeArchived") === "true";
    return context.json(sessionService.list({ includeArchived }));
  });

  app.post("/api/sessions", async (context) => {
    const body = (await context.req.json()) as {
      title?: unknown;
      cwd?: unknown;
      agentId?: unknown;
      toolMode?: unknown;
      workspaceCwd?: unknown;
      workspaceConfirmed?: unknown;
      thinkingLevel?: unknown;
    };
    if (typeof body.title !== "string" || typeof body.cwd !== "string" || !body.cwd.trim()) {
      return context.json(createApiError("INVALID_INPUT", "Session title 和 cwd 必须是字符串"), 400);
    }
    // 解析可选的 agentId，校验格式与存在性
    let agentId: string | undefined;
    if (body.agentId !== undefined) {
      if (typeof body.agentId !== "string" || !AGENT_ID_PATTERN.test(body.agentId)) {
        return context.json(createApiError("INVALID_INPUT", "Agent ID 格式无效"), 400);
      }
      if (agentStore !== undefined) {
        try {
          agentStore.load(body.agentId);
        } catch {
          return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
        }
      }
      agentId = body.agentId;
    }
    let settings: ReturnType<typeof parseSessionSettings> | undefined;
    if (
      typeof body.toolMode === "string" ||
      typeof body.workspaceCwd === "string" ||
      typeof body.thinkingLevel === "string"
    ) {
      try {
        settings = parseSessionSettings({
          ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
          ...(typeof body.workspaceCwd === "string" ? { cwd: body.workspaceCwd } : {}),
          ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
          ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
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

    const session = agentId !== undefined
      ? sessionService.create({ title: body.title, cwd: body.cwd, agentId })
      : sessionService.create({ title: body.title, cwd: body.cwd });

    // 合并设置：请求显式字段优先，缺失字段回退到全局偏好默认值。
    const preferences = preferencesStore?.get();
    const wantsThinkingLevel = settings?.thinkingLevel !== undefined
      ? settings.thinkingLevel
      : preferences?.defaults.thinkingLevel;
    // toolMode=all 必须由用户在请求中显式确认工作区；全局默认如果是 all 也无法
    // 自动满足确认条件，因此当回退来源是全局默认且为 all 时退化为 read-only。
    const effectiveToolMode =
      settings?.toolMode !== undefined
        ? settings.toolMode
        : preferences?.defaults.toolMode === "all"
          ? "read-only"
          : preferences?.defaults.toolMode;

    const updates: {
      toolMode?: string;
      workspaceCwd?: string;
      workspaceConfirmed?: boolean;
      thinkingLevel?: string;
    } = {};
    if (effectiveToolMode !== undefined) updates.toolMode = effectiveToolMode;
    if (settings?.cwd) updates.workspaceCwd = settings.cwd;
    if (settings?.workspaceConfirmed !== undefined) updates.workspaceConfirmed = settings.workspaceConfirmed;
    if (wantsThinkingLevel !== undefined) updates.thinkingLevel = wantsThinkingLevel;

    if (Object.keys(updates).length > 0) {
      sessionService.updateSettings(session.id, updates);
    }

    // 应用全局默认模型：仅当请求未指定模型、全局默认可用且可 resolve 时。
    const view = sessionService.getView(session.id);
    if (preferences?.defaults.model && modelService !== undefined && view.model === null) {
      const defaultModel = preferences.defaults.model;
      try {
        modelService.resolveModel(defaultModel.providerId, defaultModel.modelId);
        const opened = sessionService.open(session.id);
        opened.selectModel(defaultModel.providerId, defaultModel.modelId);
      } catch {
        // 默认模型不可用时不阻塞创建，留给后续显式选择。
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
      if (modelService !== undefined) {
        try {
          modelService.resolveModel(body.providerId, body.modelId);
        } catch {
          return context.json(createApiError("INVALID_INPUT", "模型不存在或凭据不可用"), 400);
        }
      }
      if (promptService?.invalidate(session.id) === "busy") {
        return context.json(createApiError("CONFLICT", "Session 正在运行，暂时不能切换模型"), 409);
      }
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
      const current = sessionService.getView(sessionId);
      const requestedCwd = typeof body.workspaceCwd === "string"
        ? body.workspaceCwd
        : typeof body.cwd === "string"
          ? body.cwd
          : undefined;
      const currentCwd = current.workspaceCwd ?? undefined;
      const cwdChanged = requestedCwd !== undefined &&
        path.resolve(requestedCwd) !== path.resolve(currentCwd ?? "");
      const requestedMode = typeof body.toolMode === "string"
        ? body.toolMode
        : current.toolMode;
      const modeRequiresFreshConfirmation = requestedMode === "all" &&
        current.toolMode !== "all";
      if (
        requestedMode === "all" &&
        (cwdChanged || modeRequiresFreshConfirmation) &&
        body.workspaceConfirmed !== true
      ) {
        return context.json(
          createApiError("INVALID_INPUT", "切换完整工具权限或工作目录必须重新确认"),
          400,
        );
      }
      try {
        parseSessionSettings({
          ...(requestedMode !== undefined ? { toolMode: requestedMode } : {}),
          ...(requestedCwd !== undefined ? { cwd: requestedCwd } : {}),
          workspaceConfirmed: body.workspaceConfirmed ?? current.workspaceConfirmed,
          thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
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

      if (promptService?.invalidate(sessionId) === "busy") {
        return context.json(createApiError("CONFLICT", "Session 正在运行，暂时不能修改设置"), 409);
      }
      const updated = sessionService.updateSettings(sessionId, {
        ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
        ...(requestedCwd !== undefined ? { workspaceCwd: requestedCwd } : {}),
        ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
        ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
      });
      return context.json(updated);
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.delete("/api/sessions/:id", (context) => {
    try {
      const sessionId = context.req.param("id");
      if (promptService?.invalidate(sessionId) === "busy") {
        return context.json(createApiError("CONFLICT", "Session 正在运行，暂时不能归档"), 409);
      }
      return context.json(sessionService.archive(sessionId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.post("/api/sessions/:id/unarchive", (context) => {
    try {
      return context.json(sessionService.unarchive(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });
}
