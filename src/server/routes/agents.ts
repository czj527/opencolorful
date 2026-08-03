import crypto from "node:crypto";

import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import { type AuditRecordInput } from "../../observability/audit-recorder.js";
import { instrument } from "../../observability/instrument.js";
import { BASE_COLOR_TEMPLATES } from "../../contracts/base-color-templates.js";
import type { SandboxCapabilities } from "../../contracts/sandbox.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { SessionService } from "../../runtime/session-service.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((p) => typeof p === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function registerAgentRoutes(
  app: Hono,
  agentStore: AgentStore,
  sessionService?: SessionService,
  audit?: import("../../observability/audit-recorder.js").AuditRecorder,
): void {
  app.get("/api/agents", (context) => {
    try {
      return context.json(agentStore.list());
    } catch (error) {
      return context.json(
        createApiError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Agent 列表加载失败",
        ),
        500,
      );
    }
  });

  // 模板路由必须在 :id 路由之前注册，避免 templates 被当成 agentId
  app.get("/api/agents/templates", (context) => {
    return context.json(BASE_COLOR_TEMPLATES);
  });

  app.post("/api/agents", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (!isRecord(rawBody) || !hasOnlyKeys(rawBody, ["id", "name", "baseColor", "defaultCwd", "sandbox"])) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      // id 可选：提供时校验格式，未提供时服务端生成 UUID
      let agentId: string;
      if (body.id !== undefined) {
        if (typeof body.id !== "string" || !AGENT_ID_PATTERN.test(body.id)) {
          return context.json(createApiError("INVALID_INPUT", "Agent ID 格式无效"), 400);
        }
        agentId = body.id;
      } else {
        agentId = crypto.randomUUID();
      }
      if (
        typeof body.name !== "string" ||
        body.name.trim().length === 0 ||
        body.name.trim().length > 100
      ) {
        return context.json(
          createApiError("INVALID_INPUT", "Agent name 长度必须为 1-100 个字符"),
          400,
        );
      }

      // baseColor 必需（至少是空对象，空白底色合法）
      if (
        body.baseColor === undefined ||
        body.baseColor === null ||
        typeof body.baseColor !== "object" ||
        Array.isArray(body.baseColor)
      ) {
        return context.json(createApiError("INVALID_INPUT", "baseColor 必须是对象"), 400);
      }
      const bc = body.baseColor as Record<string, unknown>;
      if (!hasOnlyKeys(bc, ["persona", "personality", "replyStyle", "innerSetting"])) {
        return context.json(createApiError("INVALID_INPUT", "baseColor 包含不支持的字段"), 400);
      }
      const baseColorInput = {
        persona: typeof bc.persona === "string" ? bc.persona : "",
        personality: isStringArray(bc.personality) ? bc.personality : [],
        replyStyle: typeof bc.replyStyle === "string" ? bc.replyStyle : "",
        innerSetting: typeof bc.innerSetting === "string" ? bc.innerSetting : "",
      };

      // defaultCwd 可选
      let defaultCwd: string | null | undefined;
      if (body.defaultCwd !== undefined) {
        if (body.defaultCwd === null) {
          defaultCwd = null;
        } else if (typeof body.defaultCwd === "string") {
          if (body.defaultCwd.includes("..")) {
            return context.json(
              createApiError("INVALID_INPUT", "defaultCwd 不允许包含 .. 路径"),
              400,
            );
          }
          defaultCwd = body.defaultCwd.trim() === "" ? null : body.defaultCwd;
        } else {
          return context.json(
            createApiError("INVALID_INPUT", "defaultCwd 必须是字符串或 null"),
            400,
          );
        }
      }

      // sandbox 可选
      let sandbox: { extraReadPaths?: string[]; protectedPaths?: string[] } | undefined;
      if (body.sandbox !== undefined) {
        const sb = body.sandbox as Record<string, unknown>;
        sandbox = {};
        if (sb.extraReadPaths !== undefined) {
          if (!isStringArray(sb.extraReadPaths)) {
            return context.json(createApiError("INVALID_INPUT", "sandbox.extraReadPaths 必须是字符串数组"), 400);
          }
          sandbox.extraReadPaths = sb.extraReadPaths as string[];
        }
        if (sb.protectedPaths !== undefined) {
          if (!isStringArray(sb.protectedPaths)) {
            return context.json(createApiError("INVALID_INPUT", "sandbox.protectedPaths 必须是字符串数组"), 400);
          }
          sandbox.protectedPaths = sb.protectedPaths as string[];
        }
      }

      // 评审 P0（第四轮）：创建入口不得绕过工作区/沙箱 fail-closed 审计——
      // 请求提供 defaultCwd 或 sandbox 即属高风险（与 settings PUT 同一清单）。
      // 评审 P1（第五轮）：文件修改采用「audit started → 原子写入 → audit terminal」
      // 模型（docs/logging-architecture.md §6.5）——领域写入失败必须留下明确的
      // failed 终态（decision=denied + reasonCode），不得留下单条 allowed 成功记录。
      const auditInputs: AuditRecordInput[] = [];
      if (defaultCwd !== undefined) {
        auditInputs.push({
          eventName: "audit.agent.workspace_changed",
          payload: { action: "agent.workspace.changed", decision: "allowed", changedFields: ["defaultCwd"] },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "agent", id: agentId },
          scope: { ownerAgentId: agentId },
        });
      }
      if (sandbox !== undefined) {
        auditInputs.push({
          eventName: "audit.sandbox.policy_changed",
          payload: { action: "sandbox.policy.changed", decision: "allowed", changedFields: ["sandbox.workspaceAccess", "sandbox.extraReadPaths", "sandbox.protectedPaths"] },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "agent", id: agentId },
          scope: { ownerAgentId: agentId },
        });
      }
      // 评审 P1（第六轮）：操作级 operationId——started/completed/failed 共享，
      // 生命周期可从账本按 operation_id 关联（不再依赖插入顺序）
      const opId = crypto.randomUUID();
      const opTrace = { traceId: opId, spanId: opId, operationId: opId };
      if (auditInputs.length > 0) {
        if (audit === undefined) {
          return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，高风险创建被拒绝"), 503);
        }
        const startedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
          ...input,
          trace: opTrace,
          eventName: input.eventName === "audit.agent.workspace_changed"
            ? "audit.agent.workspace_change.started"
            : "audit.sandbox.policy_change.started",
        }));
        try {
          // 审计先行（started 原子）：任一 rejected → 全部回滚 → 拒绝创建
          audit.appendStrictMany(startedInputs);
        } catch {
          return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，高风险创建被拒绝"), 503);
        }
        try {
          agentStore.create({
            id: agentId,
            name: body.name.trim(),
            baseColor: baseColorInput,
            ...(defaultCwd !== undefined ? { defaultCwd } : {}),
            ...(sandbox ? { sandbox } : {}),
          });
        } catch (error) {
          // 领域写入失败 → failed 终态（尽力而为），绝不留下 allowed 成功记录
          const failedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
            ...input,
            trace: opTrace,
            eventName: input.eventName === "audit.agent.workspace_changed"
              ? "audit.agent.workspace_change.failed"
              : "audit.sandbox.policy_change.failed",
            payload: {
              action: input.payload.action,
              decision: "denied" as const,
              reasonCode: (error instanceof Error ? error.message : String(error)).slice(0, 64),
              changedFields: input.payload.changedFields ?? [],
            },
          }));
          try { audit.appendStrictMany(failedInputs); } catch { /* 终态尽力而为 */ }
          throw error;
        }
        // 领域写入成功 → completed 终态（原 allowed 记录）
        try {
          audit.appendStrictMany(auditInputs.map((input) => ({ ...input, trace: opTrace })));
        } catch {
          // 评审 P0（第六轮）：终态审计失败必须可靠补偿——删除刚创建的 Agent
          // 并验证（fail-closed：账本与实际状态一致，不留下"503 但 Agent 已落盘"）
          let compensated = false;
          try {
            agentStore.remove(agentId);
            agentStore.list(); // 触发目录重读，验证补偿结果
            compensated = true;
          } catch { /* 补偿失败：账本只剩 started，不伪装成功 */ }
          try {
            const failedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
              ...input,
              trace: opTrace,
              eventName: input.eventName === "audit.agent.workspace_changed"
                ? "audit.agent.workspace_change.failed"
                : "audit.sandbox.policy_change.failed",
              payload: { action: input.payload.action, decision: "denied" as const, reasonCode: compensated ? "audit_terminal_write_failed" : "compensation_failed", changedFields: input.payload.changedFields ?? [] },
            }));
            audit.appendStrictMany(failedInputs);
          } catch { /* 终态尽力而为 */ }
          return context.json(createApiError("PROVIDER_UNAVAILABLE", compensated ? "安全审计不可用，高风险创建已回滚" : "安全审计不可用，高风险创建已回滚但补偿验证失败"), 503);
        }
      } else {
        agentStore.create({
          id: agentId,
          name: body.name.trim(),
          baseColor: baseColorInput,
        });
      }
      // 评审 P1（第三轮）：Agent 创建进 Activity 时间线（milestone）
      instrument.activity({
        eventName: "agent.created",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "agent", id: agentId },
        scope: { ownerAgentId: agentId },
        payload: { summaryCode: "agent_created" },
      });
      return context.json(agentStore.load(agentId), 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "创建失败";
      if (msg.includes("已存在")) {
        return context.json(createApiError("CONFLICT", msg), 409);
      }
      return context.json(createApiError("INVALID_INPUT", msg), 400);
    }
  });

  app.get("/api/agents/:id", (context) => {
    try {
      return context.json(agentStore.load(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  // identity 只能改 name（id/createdAt/version 不可变）
  app.put("/api/agents/:id", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (!isRecord(rawBody) || !hasOnlyKeys(rawBody, ["name"])) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: { name?: string } = {};
      if (body.name !== undefined) {
        if (
          typeof body.name !== "string" ||
          body.name.trim().length === 0 ||
          body.name.trim().length > 100
        ) {
          return context.json(
            createApiError("INVALID_INPUT", "name 长度必须为 1-100 个字符"),
            400,
          );
        }
        patch.name = body.name.trim();
      }
      if (Object.keys(patch).length === 0) {
        return context.json(createApiError("INVALID_INPUT", "没有可更新的字段"), 400);
      }
      const identity = agentStore.updateIdentity(context.req.param("id"), patch);
      // 评审 P1（第三轮）：名称修改进 Activity 时间线（notable）
      instrument.activity({
        eventName: "agent.settings.changed",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "agent", id: identity.id },
        scope: { ownerAgentId: identity.id },
        payload: { summaryCode: "agent_settings_changed", attributes: { changedFields: ["name"] } },
      });
      return context.json(agentStore.load(identity.id));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.get("/api/agents/:id/base-color", (context) => {
    try {
      return context.json(agentStore.getBaseColor(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id/base-color", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (
        !isRecord(rawBody) ||
        !hasOnlyKeys(rawBody, ["persona", "personality", "replyStyle", "innerSetting"])
      ) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: {
        persona?: string;
        personality?: string[];
        replyStyle?: string;
        innerSetting?: string;
      } = {};

      if (body.persona !== undefined) {
        if (typeof body.persona !== "string") {
          return context.json(createApiError("INVALID_INPUT", "persona 必须是字符串"), 400);
        }
        patch.persona = body.persona;
      }
      if (body.personality !== undefined) {
        if (!isStringArray(body.personality)) {
          return context.json(
            createApiError("INVALID_INPUT", "personality 必须是字符串数组"),
            400,
          );
        }
        patch.personality = body.personality;
      }
      if (body.replyStyle !== undefined) {
        if (typeof body.replyStyle !== "string") {
          return context.json(createApiError("INVALID_INPUT", "replyStyle 必须是字符串"), 400);
        }
        patch.replyStyle = body.replyStyle;
      }
      if (body.innerSetting !== undefined) {
        if (typeof body.innerSetting !== "string") {
          return context.json(
            createApiError("INVALID_INPUT", "innerSetting 必须是字符串"),
            400,
          );
        }
        patch.innerSetting = body.innerSetting;
      }

      agentStore.saveBaseColor(context.req.param("id"), patch);
      // 评审 P1（第三轮）：底色修改进 Activity 时间线（notable）
      const baseColorAgentId = context.req.param("id");
      instrument.activity({
        eventName: "agent.base_color.changed",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "agent", id: baseColorAgentId },
        scope: { ownerAgentId: baseColorAgentId },
        payload: { summaryCode: "agent_base_color_changed" },
      });
      return context.json(agentStore.load(baseColorAgentId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.get("/api/agents/:id/settings", (context) => {
    try {
      return context.json(agentStore.getSettings(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id/settings", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (
        !isRecord(rawBody) ||
        !hasOnlyKeys(rawBody, ["defaultCwd", "extraReadPaths", "protectedPaths", "memory"])
      ) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: {
        defaultCwd?: string | null;
        sandbox?: SandboxCapabilities;
        memory?: import("../../contracts/memory.js").MemoryAgentSettings;
      } = {};

      // 读取现有 sandbox 避免更新一个字段时清空另一个
      let existingSandbox: SandboxCapabilities | undefined;
      try {
        const s = agentStore.getSettings(context.req.param("id"));
        existingSandbox = s.sandbox;
      } catch { /* 读取失败使用空默认 */ }

      if (body.defaultCwd !== undefined) {
        if (body.defaultCwd === null) {
          patch.defaultCwd = null;
        } else if (typeof body.defaultCwd === "string") {
          if (body.defaultCwd.includes("..")) {
            return context.json(
              createApiError("INVALID_INPUT", "defaultCwd 不允许包含 .. 路径"),
              400,
            );
          }
          patch.defaultCwd = body.defaultCwd.trim() === "" ? null : body.defaultCwd;
        } else {
          return context.json(
            createApiError("INVALID_INPUT", "defaultCwd 必须是字符串或 null"),
            400,
          );
        }
      }

      // sandbox extraReadPaths
      if (body.extraReadPaths !== undefined) {
        if (!isStringArray(body.extraReadPaths)) {
          return context.json(
            createApiError("INVALID_INPUT", "extraReadPaths 必须是字符串数组"),
            400,
          );
        }
        if (body.extraReadPaths.some((p: string) => p.includes(".."))) {
          return context.json(
            createApiError("INVALID_INPUT", "extraReadPaths 不允许包含 .. 路径"),
            400,
          );
        }
        patch.sandbox = {
          workspaceAccess: "rw" as const,
          extraReadPaths: body.extraReadPaths as string[],
          protectedPaths: patch.sandbox?.protectedPaths ?? existingSandbox?.protectedPaths ?? [],
        };
      }

      // sandbox protectedPaths
      if (body.protectedPaths !== undefined) {
        if (!isStringArray(body.protectedPaths)) {
          return context.json(
            createApiError("INVALID_INPUT", "protectedPaths 必须是字符串数组"),
            400,
          );
        }
        if (body.protectedPaths.some((p: string) => p.includes(".."))) {
          return context.json(
            createApiError("INVALID_INPUT", "protectedPaths 不允许包含 .. 路径"),
            400,
          );
        }
        patch.sandbox = {
          workspaceAccess: "rw" as const,
          extraReadPaths: patch.sandbox?.extraReadPaths ?? existingSandbox?.extraReadPaths ?? [],
          protectedPaths: body.protectedPaths as string[],
        };
      }

      // Phase 10.5：记忆设置（完整对象，经 schema 校验）
      if (body.memory !== undefined) {
        const { Value } = await import("typebox/value");
        const { MemoryAgentSettingsSchema, isValidRetentionThresholds } = await import("../../contracts/memory.js");
        if (!Value.Check(MemoryAgentSettingsSchema, body.memory)) {
          return context.json(createApiError("INVALID_INPUT", "memory 设置不合法"), 400);
        }
        // 评审 P1#7a：迟滞阈值排序校验（TypeBox 无法表达跨字段约束）
        const memorySettings = body.memory as import("../../contracts/memory.js").MemoryAgentSettings;
        if (!isValidRetentionThresholds(memorySettings.retentionThresholds)) {
          return context.json(createApiError("INVALID_INPUT", "迟滞阈值必须满足 mediumDown < mediumUp < permanentUp"), 400);
        }
        patch.memory = body.memory;
      }

      if (Object.keys(patch).length === 0) {
        return context.json(createApiError("INVALID_INPUT", "没有可更新的字段"), 400);
      }
      const agentId = context.req.param("id");
      // 评审 P0-1：沙箱策略/工作目录变更属 fail-closed 清单——
      // 评审 P1（第五轮）：文件修改采用「audit started → 原子写入 → audit terminal」
      // 模型（docs/logging-architecture.md §6.5）——started 先行（fail-closed），
      // 领域写入成功记 completed（allowed），失败回滚并记 failed（denied）终态。
      const previousSettings = agentStore.load(agentId).settings;
      const auditInputs: AuditRecordInput[] = [];
      if (patch.defaultCwd !== undefined) {
        auditInputs.push({
          eventName: "audit.agent.workspace_changed",
          payload: { action: "agent.workspace.changed", decision: "allowed", changedFields: ["defaultCwd"] },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "agent", id: agentId },
          scope: { ownerAgentId: agentId },
        });
      }
      if (patch.sandbox !== undefined) {
        auditInputs.push({
          eventName: "audit.sandbox.policy_changed",
          payload: { action: "sandbox.policy.changed", decision: "allowed", changedFields: ["sandbox.workspaceAccess", "sandbox.extraReadPaths", "sandbox.protectedPaths"] },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          target: { kind: "agent", id: agentId },
          scope: { ownerAgentId: agentId },
        });
      }
      // 评审 P1（第六轮）：操作级 operationId——started/completed/failed 共享
      const opId = crypto.randomUUID();
      const opTrace = { traceId: opId, spanId: opId, operationId: opId };
      if (auditInputs.length > 0) {
        try {
          // 评审 P0（第三轮）：audit 未配置同样拒绝执行（fail-closed 由构造保证不了，这里显式检查）；
          // 评审 P1（第四轮）：多条审计单事务原子写入——任一 rejected 全部回滚
          if (audit === undefined) throw new Error("可观测性未初始化，高风险修改拒绝执行");
          const startedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
            ...input,
            trace: opTrace,
            eventName: input.eventName === "audit.agent.workspace_changed"
              ? "audit.agent.workspace_change.started"
              : "audit.sandbox.policy_change.started",
          }));
          audit.appendStrictMany(startedInputs);
        } catch {
          // fail-closed：Audit 无法持久化 → 拒绝操作（设置尚未写入）
          return context.json(createApiError("PROVIDER_UNAVAILABLE", "安全审计不可用，高风险修改被拒绝"), 503);
        }
        try {
          agentStore.saveSettings(agentId, patch);
        } catch (error) {
          // 领域写入失败 → failed 终态（尽力而为）并拒绝操作
          try {
            const failedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
              ...input,
              trace: opTrace,
              eventName: input.eventName === "audit.agent.workspace_changed"
                ? "audit.agent.workspace_change.failed"
                : "audit.sandbox.policy_change.failed",
              payload: { action: input.payload.action, decision: "denied" as const, reasonCode: (error instanceof Error ? error.message : String(error)).slice(0, 64), changedFields: input.payload.changedFields ?? [] },
            }));
            audit!.appendStrictMany(failedInputs);
          } catch { /* 终态尽力而为 */ }
          throw error;
        }
        try {
          // 领域写入成功 → completed 终态
          audit.appendStrictMany(auditInputs.map((input) => ({ ...input, trace: opTrace })));
        } catch {
          // 评审 P0（第六轮）：终态审计失败必须可靠补偿——恢复 previousSettings
          // 并验证恢复结果（不再吞掉恢复异常；恢复失败必须如实报告）
          let compensated = false;
          try {
            agentStore.saveSettings(agentId, previousSettings);
            const restored = agentStore.getSettings(agentId);
            const restoredSandbox = "sandbox" in restored ? restored.sandbox : undefined;
            const previousSandbox = "sandbox" in previousSettings ? previousSettings.sandbox : undefined;
            compensated = JSON.stringify({ defaultCwd: restored.defaultCwd, sandbox: restoredSandbox })
              === JSON.stringify({ defaultCwd: previousSettings.defaultCwd, sandbox: previousSandbox });
          } catch { /* 恢复失败：账本只剩 started，不伪装成功 */ }
          try {
            const failedInputs: AuditRecordInput[] = auditInputs.map((input) => ({
              ...input,
              trace: opTrace,
              eventName: input.eventName === "audit.agent.workspace_changed"
                ? "audit.agent.workspace_change.failed"
                : "audit.sandbox.policy_change.failed",
              payload: { action: input.payload.action, decision: "denied" as const, reasonCode: compensated ? "audit_terminal_write_failed" : "compensation_failed", changedFields: input.payload.changedFields ?? [] },
            }));
            audit.appendStrictMany(failedInputs);
          } catch { /* 终态尽力而为 */ }
          return context.json(createApiError("PROVIDER_UNAVAILABLE", compensated ? "安全审计不可用，高风险修改已回滚" : "安全审计不可用，高风险修改已回滚但补偿验证失败"), 503);
        }
      } else {
        agentStore.saveSettings(agentId, patch);
      }
      // 评审 P1（第三轮）：设置变更进 Activity 时间线（audit fail-closed 已在前）
      instrument.activity({
        eventName: "agent.settings.changed",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "agent", id: agentId },
        scope: { ownerAgentId: agentId },
        payload: { summaryCode: "agent_settings_changed", attributes: { changedFields: Object.keys(patch) } },
      });
      return context.json(agentStore.load(agentId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.post("/api/agents/:id/archive", (context) => {
    try {
      const archivedAgentId = context.req.param("id");
      agentStore.archive(archivedAgentId);
      // 评审 P1（第三轮）：归档进 Activity 时间线（notable）
      instrument.activity({
        eventName: "agent.archived",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "agent", id: archivedAgentId },
        scope: { ownerAgentId: archivedAgentId },
        payload: { summaryCode: "agent_archived" },
      });
      return context.json({ status: "archived" });
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  if (sessionService !== undefined) {
    app.get("/api/agents/:id/sessions", (context) => {
      try {
        const agentId = context.req.param("id");
        return context.json(sessionService.listByAgent(agentId));
      } catch {
        return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
      }
    });
  }
}
