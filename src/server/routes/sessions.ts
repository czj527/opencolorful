import type { Hono } from "hono";
import crypto from "node:crypto";
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
import { assertDurableAudit, type AuditRecordInput } from "../../observability/audit-recorder.js";
import { instrument } from "../../observability/instrument.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerSessionRoutes(
  app: Hono,
  sessionService: SessionService,
  modelService?: ModelService,
  promptService?: PromptService,
  preferencesStore?: PreferencesStore,
  agentStore?: AgentStore,
  audit?: import("../../observability/audit-recorder.js").AuditRecorder,
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
          // 读取 Agent 设置以触发 v1→v2 迁移，确保沙箱配置就绪
          agentStore.getSettings(body.agentId);
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

    // 评审 P0（第四轮）：Session 创建即绑定工作目录（index 恒写入 workspaceCwd），
    // 与 settings PUT 的 cwd 变更同属 fail-closed 清单——审计先行。
    // 评审 P1（第五轮）：文件修改采用「audit started → 原子写入 → audit terminal」
    // 模型（docs/logging-architecture.md §6.5）——创建失败必须留下 failed 终态，
    // 不得留下单条 allowed 成功记录；scope.sessionId 保证按会话归属可查。
    // 预生成 id 使审计记录携带精确 target（审计先于创建，无半成品会话）。
    const sessionId = crypto.randomUUID();
    if (audit === undefined) {
      return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，会话创建被拒绝"), 503);
    }
    // 评审 P1（第六轮）：操作级 operationId——started/completed/failed 共享；
    // 绑定 Agent 的会话审计 scope 同时携带 sessionId + ownerAgentId（按归属可查）
    const opId = sessionId;
    const opTrace = { traceId: opId, spanId: opId, operationId: opId };
    const bindScope = agentId !== undefined ? { sessionId, ownerAgentId: agentId } : { sessionId };
    const startedInput: AuditRecordInput = {
      eventName: "audit.session.workspace_bind.started",
      payload: { action: "session.workspace.bound", decision: "allowed", changedFields: ["workspaceCwd"] },
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
      target: { kind: "session", id: sessionId },
      scope: bindScope,
      trace: opTrace,
    };
    try {
      assertDurableAudit(audit.appendStrict(startedInput), "Session 工作区绑定");
    } catch {
      return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，会话创建被拒绝"), 503);
    }
    try {
      const session = agentId !== undefined
        ? sessionService.create({ id: sessionId, title: body.title, cwd: body.cwd, agentId })
        : sessionService.create({ id: sessionId, title: body.title, cwd: body.cwd });

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
    } catch (error) {
      // create 后的任一步失败都必须移除刚创建的精确 Session 文件和索引。
      let compensated = false;
      try {
        sessionService.remove(sessionId);
        compensated = !sessionService.list({ includeArchived: true }).some((item) => item.id === sessionId);
      } catch { /* failed 终态会如实记录补偿失败 */ }
      try {
        audit.appendStrict({
          eventName: "audit.session.workspace_bind.failed",
          payload: {
            action: "session.workspace.bound",
            decision: "denied",
            reasonCode: compensated ? (error instanceof Error ? error.message : String(error)).slice(0, 64) : "compensation_failed",
            changedFields: ["workspaceCwd"],
          },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "session", id: sessionId },
          scope: bindScope,
          trace: opTrace,
        });
      } catch { /* 终态尽力而为 */ }
      return context.json(
        createApiError(
          "INTERNAL_ERROR",
          compensated ? (error instanceof Error ? error.message : "会话创建失败") : "会话创建失败，且补偿验证失败",
        ),
        500,
      );
    }
    try {
      // 领域写入成功 → completed 终态（原 allowed 记录）
      assertDurableAudit(audit.appendStrict({
        eventName: "audit.session.workspace_bound",
        payload: { action: "session.workspace.bound", decision: "allowed", changedFields: ["workspaceCwd"] },
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "session", id: sessionId },
        scope: bindScope,
        trace: opTrace,
      }), "Session 工作区绑定");
    } catch {
      // 评审 P0（第六轮）：终态审计失败必须可靠补偿——移除刚创建的会话并验证
      let compensated = false;
      try {
        sessionService.remove(sessionId);
        compensated = !sessionService.list().some((item) => item.id === sessionId);
      } catch { /* 补偿失败：账本只剩 started，不伪装成功 */ }
      try {
        audit.appendStrict({
          eventName: "audit.session.workspace_bind.failed",
          payload: { action: "session.workspace.bound", decision: "denied", reasonCode: compensated ? "audit_terminal_write_failed" : "compensation_failed", changedFields: ["workspaceCwd"] },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "session", id: sessionId },
          scope: bindScope,
          trace: opTrace,
        });
      } catch { /* 终态尽力而为 */ }
      return context.json(createApiError("PROVIDER_UNAVAILABLE", compensated ? "安全审计不可用，会话创建已回滚" : "安全审计不可用，会话创建已回滚但补偿验证失败"), 503);
    }
    // 工作区绑定证据（audit 已 fail-closed 在前）
    instrument.activity({
      eventName: "session.workspace.bound",
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
      target: { kind: "session", id: sessionId },
      scope: bindScope,
      payload: { summaryCode: "session_workspace_bound" },
    });

    // 应用全局默认模型：仅当请求未指定模型、全局默认可用且可 resolve 时。
    const preferences = preferencesStore?.get();
    const view = sessionService.getView(sessionId);
    if (preferences?.defaults.model && modelService !== undefined && view.model === null) {
      const defaultModel = preferences.defaults.model;
      try {
        modelService.resolveModel(defaultModel.providerId, defaultModel.modelId);
        const opened = sessionService.open(sessionId);
        opened.selectModel(defaultModel.providerId, defaultModel.modelId);
      } catch {
        // 默认模型不可用时不阻塞创建，留给后续显式选择。
      }
    }

    return context.json(sessionService.getView(sessionId), 201);
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
      // 仅当 cwd 变更且会把写权限带到新目录时才强制重新确认；
      // 从非 all 切到 all 但未确认则放行，由运行时降级为只读工具。
      const willHaveWritePermission = requestedMode === "all" ||
        current.toolMode === "all";
      if (
        cwdChanged &&
        willHaveWritePermission &&
        body.workspaceConfirmed !== true
      ) {
        return context.json(
          createApiError("INVALID_INPUT", "切换完整工具权限或工作目录必须重新确认"),
          400,
        );
      }
      // 评审 P1（第六轮）：绑定 Agent 的会话设置变更 scope 同时携带 sessionId + ownerAgentId
      const bindScope = current.agentId !== undefined && current.agentId !== null ? { sessionId, ownerAgentId: current.agentId } : { sessionId };
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
      // 评审 P0（第三轮）：工作目录变更属 fail-closed 清单——索引修改与 Audit 同一
      // SQLite 事务（runAuditedTransaction），Audit 无法持久化则整体回滚；
      // 审计未配置同样拒绝（不再静默放行）。
      // 纯工具模式/思维级别等非高风险字段不走审计事务。
      if (cwdChanged) {
        if (audit === undefined) {
          return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，工作目录修改被拒绝"), 503);
        }
        try {
          audit.runAuditedTransaction(
            {
              eventName: "audit.session.workspace_bound",
              payload: {
                action: "session.workspace.bound",
                decision: "allowed",
                changedFields: ["workspaceCwd"],
              },
              actor: { kind: "user", id: "web" },
              executor: { kind: "service", id: "agent-server" },
              target: { kind: "session", id: sessionId },
              scope: bindScope,
              trace: { traceId: sessionId, spanId: sessionId, operationId: sessionId },
            },
            () => sessionService.updateSettings(sessionId, {
              ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
              ...(requestedCwd !== undefined ? { workspaceCwd: requestedCwd } : {}),
              ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
              ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
            }),
          );
        } catch {
          // fail-closed：Audit 无法持久化 → 领域修改回滚并拒绝操作
          return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，工作目录修改被拒绝"), 503);
        }
      } else {
        sessionService.updateSettings(sessionId, {
          ...(typeof body.toolMode === "string" ? { toolMode: body.toolMode } : {}),
          ...(requestedCwd !== undefined ? { workspaceCwd: requestedCwd } : {}),
          ...(typeof body.workspaceConfirmed === "boolean" ? { workspaceConfirmed: body.workspaceConfirmed } : {}),
          ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
        });
      }
      // 评审 P1（第三轮）：工作目录变更进 Activity 时间线（audit 已 fail-closed 在前）
      if (cwdChanged) {
        instrument.activity({
          eventName: "session.workspace.bound",
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "session", id: sessionId },
          scope: { sessionId },
          payload: { summaryCode: "session_workspace_bound" },
        });
      }
      return context.json(sessionService.getView(sessionId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
    }
  });

  app.put("/api/sessions/:id/title", async (context) => {
    try {
      const sessionId = context.req.param("id");
      // 验证 session 存在（不存在时 getView 抛错）
      sessionService.getView(sessionId);
      const body = (await context.req.json()) as { title?: unknown };
      if (typeof body.title !== "string" || !body.title.trim()) {
        return context.json(createApiError("INVALID_INPUT", "Session title 不能为空"), 400);
      }
      const trimmed = body.title.trim();
      if (trimmed.length > 200) {
        return context.json(createApiError("INVALID_INPUT", "Session title 过长"), 400);
      }
      const updated = sessionService.renameSession(sessionId, trimmed);
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
