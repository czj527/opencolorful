import type { EventCatalogEntry } from "../contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 事件目录（plans/phase-11.md §6）
//
// 注册表是唯一权威：每个 durable event 只有一条注册记录；
// Recorder 按 eventName+eventVersion 查目录，调用方不能覆盖
// channel/defaultLevel/significance；未注册事件默认拒绝。
//
// significance 冻结（§6.5）：
// - milestone：永久 Agent 生命周期边界（agent.created/agent.deleted），仅平台内置；
// - notable：关键设置/工作区/归档/Provider 状态/记忆审批强度/迁移恢复结果；
// - routine：Turn/模型/工具/回想/摘要/批次/连接与普通失败恢复。
//
// 审计镜像（§6.3）：同名 Activity 用于时间线，Audit 用于责任与策略证据。
// ═══════════════════════════════════════════════════════════════

const routine = { significance: "routine", producerPolicy: "platform-only" } as const;
const notable = { significance: "notable", producerPolicy: "platform-only" } as const;

function entry(input: Omit<EventCatalogEntry, "producerPolicy" | "securitySummary"> & { producerPolicy?: EventCatalogEntry["producerPolicy"]; securitySummary?: EventCatalogEntry["securitySummary"] }): EventCatalogEntry {
  return {
    producerPolicy: "platform-only",
    securitySummary: "exclude",
    ...input,
  };
}

/** 事件目录：eventName → 注册记录（唯一权威，禁止重复/遗漏） */
export const ObservabilityEventCatalog: ReadonlyMap<string, EventCatalogEntry> = new Map(
  (
    [
      // ── 平台与存储 ──
      entry({ eventName: "system.starting", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...notable }),
      entry({ eventName: "system.started", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),
      entry({ eventName: "system.stopping", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...notable }),
      entry({ eventName: "system.stopped", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),
      entry({ eventName: "system.crashed", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
      entry({ eventName: "system.recovery.started", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...notable }),
      entry({ eventName: "system.recovery.completed", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...notable }),
      entry({ eventName: "system.recovery.failed", eventVersion: 1, channel: "activity", category: "system", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

      entry({ eventName: "supervisor.server.started", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "supervisor.server.stopped", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "supervisor.server.restarted", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "supervisor.server.crashed", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
      entry({ eventName: "supervisor.health.degraded", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
      entry({ eventName: "supervisor.health.recovered", eventVersion: 1, channel: "activity", category: "supervisor", defaultLevel: "info", lifecycleRole: "point", ...notable }),

      entry({ eventName: "storage.database.opened", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "storage.database.failed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
      entry({ eventName: "storage.migration.started", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...notable }),
      entry({ eventName: "storage.migration.completed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),
      entry({ eventName: "storage.migration.failed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
      entry({ eventName: "storage.repair.started", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "warn", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...notable }),
      entry({ eventName: "storage.repair.completed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...notable }),
      entry({ eventName: "storage.repair.failed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
      entry({ eventName: "storage.corruption.detected", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "error", lifecycleRole: "point", ...notable }),
      entry({ eventName: "storage.write.failed", eventVersion: 1, channel: "activity", category: "storage", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

      // ── Agent 与 Session ──
      entry({ eventName: "agent.created", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", significance: "milestone" }),
      entry({ eventName: "agent.started", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "agent.stopped", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "agent.archived", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "agent.deleted", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["completed"], significance: "milestone", auditMirror: "audit.agent.deleted" }),
      entry({ eventName: "agent.base_color.changed", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "agent.settings.changed", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "agent.workspace.changed", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.agent.workspace_changed" }),
      entry({ eventName: "agent.migration.completed", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),
      entry({ eventName: "agent.migration.failed", eventVersion: 1, channel: "activity", category: "agent", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

      entry({ eventName: "session.created", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "session.bound", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "session.opened", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "session.archived", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "session.unarchived", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "session.workspace.bound", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.session.workspace_bound" }),
      entry({ eventName: "session.compaction.started", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...routine }),
      entry({ eventName: "session.compaction.completed", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "session.compaction.failed", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "session.recovery.completed", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...notable }),
      entry({ eventName: "session.recovery.failed", eventVersion: 1, channel: "activity", category: "session", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

      // ── Turn、模型与 Provider ──
      entry({ eventName: "turn.started", eventVersion: 1, channel: "activity", category: "turn", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...routine }),
      entry({ eventName: "turn.completed", eventVersion: 1, channel: "activity", category: "turn", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "turn.failed", eventVersion: 1, channel: "activity", category: "turn", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "turn.cancelled", eventVersion: 1, channel: "activity", category: "turn", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...routine }),
      entry({ eventName: "turn.interrupted", eventVersion: 1, channel: "activity", category: "turn", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["interrupted"], ...routine }),

      entry({ eventName: "model.call.started", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...routine }),
      entry({ eventName: "model.call.completed", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...routine }),
      entry({ eventName: "model.call.failed", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "model.call.cancelled", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...routine }),
      entry({ eventName: "model.call.retrying", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "warn", lifecycleRole: "progress", ...routine }),
      entry({ eventName: "model.call.rate_limited", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "warn", lifecycleRole: "progress", ...routine }),
      entry({ eventName: "model.fallback.selected", eventVersion: 1, channel: "activity", category: "model", defaultLevel: "warn", lifecycleRole: "point", ...routine }),

      entry({ eventName: "provider.configured", eventVersion: 1, channel: "activity", category: "provider", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "provider.tested", eventVersion: 1, channel: "activity", category: "provider", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "failed"], ...routine }),
      entry({ eventName: "provider.degraded", eventVersion: 1, channel: "activity", category: "provider", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
      entry({ eventName: "provider.recovered", eventVersion: 1, channel: "activity", category: "provider", defaultLevel: "info", lifecycleRole: "point", ...notable }),
      entry({ eventName: "provider.credential.changed", eventVersion: 1, channel: "activity", category: "provider", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.provider.credential_changed" }),

      // ── 工具与沙箱 ──
      entry({ eventName: "tool.call.started", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "denied", "interrupted"], ...routine }),
      entry({ eventName: "tool.call.completed", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "tool.call.failed", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "tool.call.cancelled", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...routine }),
      entry({ eventName: "tool.call.denied", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["denied"], ...routine }),
      entry({ eventName: "tool.approval.requested", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "tool.approval.granted", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.tool.approval_granted" }),
      entry({ eventName: "tool.approval.denied", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.tool.approval_denied" }),
      entry({ eventName: "workspace.operation.failed", eventVersion: 1, channel: "activity", category: "tool", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "sandbox.path.denied", eventVersion: 1, channel: "activity", category: "sandbox", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["denied"], ...notable, auditMirror: "audit.sandbox.path_denied" }),
      entry({ eventName: "sandbox.command.denied", eventVersion: 1, channel: "activity", category: "sandbox", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["denied"], ...notable, auditMirror: "audit.sandbox.command_denied" }),
      entry({ eventName: "sandbox.policy.changed", eventVersion: 1, channel: "activity", category: "sandbox", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.sandbox.policy_changed" }),
      entry({ eventName: "sandbox.context.missing", eventVersion: 1, channel: "activity", category: "sandbox", defaultLevel: "warn", lifecycleRole: "point", ...routine }),
      entry({ eventName: "sandbox.guard.failed", eventVersion: 1, channel: "activity", category: "sandbox", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),

      // ── 记忆 ──
      entry({ eventName: "memory.summary.started", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "degraded", "failed", "interrupted"], ...routine }),
      entry({ eventName: "memory.summary.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.summary.degraded", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["degraded"], ...routine }),
      entry({ eventName: "memory.summary.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.compile.started", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...routine }),
      entry({ eventName: "memory.compile.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.compile.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.recall.started", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...routine }),
      entry({ eventName: "memory.recall.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.recall.empty", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.recall.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.recall.cancelled", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...routine }),
      entry({ eventName: "memory.batch.sealed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "memory.batch.processing", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "progress", ...routine }),
      entry({ eventName: "memory.batch.deferred", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["deferred"], ...routine }),
      entry({ eventName: "memory.batch.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.batch.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.agent.started", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "deferred", "failed", "interrupted"], ...routine }),
      entry({ eventName: "memory.agent.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...routine }),
      entry({ eventName: "memory.agent.deferred", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["deferred"], ...routine }),
      entry({ eventName: "memory.agent.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.agent.interrupted", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["interrupted"], ...routine }),
      entry({ eventName: "memory.proposal.created", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "memory.proposal.approved", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.proposal_approved" }),
      entry({ eventName: "memory.proposal.rejected", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.proposal_rejected" }),
      entry({ eventName: "memory.proposal.conflicted", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "point", ...routine }),
      entry({ eventName: "memory.strength.changed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.strength_changed" }),
      entry({ eventName: "memory.fact.superseded", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.fact_superseded" }),
      entry({ eventName: "memory.fact.forgotten", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.fact_forgotten" }),
      entry({ eventName: "memory.fact.suppressed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.memory.fact_suppressed" }),
      entry({ eventName: "memory.scheduler.run.started", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "deferred", "interrupted"], ...routine }),
      entry({ eventName: "memory.scheduler.run.completed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
      entry({ eventName: "memory.scheduler.run.failed", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "memory.scheduler.run.deferred", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["deferred"], ...routine }),
      entry({ eventName: "memory.scheduler.run.recovered", eventVersion: 1, channel: "activity", category: "memory", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...notable }),

      // ── 接口与连接 ──
      entry({ eventName: "api.request.failed", eventVersion: 1, channel: "activity", category: "api", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "api.validation.failed", eventVersion: 1, channel: "activity", category: "api", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["denied"], ...routine }),
      entry({ eventName: "sse.connected", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "sse.disconnected", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "sse.replay.reset", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "warn", lifecycleRole: "point", ...routine }),
      entry({ eventName: "ws.connected", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "ws.disconnected", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "ws.reconnected", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "info", lifecycleRole: "point", ...routine }),
      entry({ eventName: "ws.protocol.failed", eventVersion: 1, channel: "activity", category: "connection", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
      entry({ eventName: "client.unhandled_error", eventVersion: 1, channel: "activity", category: "client", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine, producerPolicy: "extension-allowed" }),
      entry({ eventName: "client.render.failed", eventVersion: 1, channel: "activity", category: "client", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine, producerPolicy: "extension-allowed" }),

      // ── 插件与 Observability 运维 ──
      entry({ eventName: "plugin.permission.granted", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_granted" }),
      entry({ eventName: "plugin.permission.denied", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_denied" }),
      entry({ eventName: "plugin.permission.revoked", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_revoked" }),
      entry({ eventName: "observability.preferences.changed", eventVersion: 1, channel: "activity", category: "observability", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.observability.preferences_changed" }),
      entry({ eventName: "observability.retention.executed", eventVersion: 1, channel: "activity", category: "observability", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.observability.retention_executed" }),
      entry({ eventName: "observability.export.created", eventVersion: 1, channel: "activity", category: "observability", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "failed"], ...notable, auditMirror: "audit.observability.export_created" }),
      entry({ eventName: "observability.audit.ledger_reset", eventVersion: 1, channel: "activity", category: "observability", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["completed"], significance: "milestone", auditMirror: "audit.observability.ledger_reset" }),

      // ── Audit-only（不产生同名 Activity 的时间线镜像） ──
      entry({ eventName: "audit.agent.deleted", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "milestone" }),
      entry({ eventName: "audit.agent.workspace_changed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.session.workspace_bound", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.sandbox.path_denied", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.sandbox.command_denied", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.sandbox.policy_changed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.tool.approval_granted", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.tool.approval_denied", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.provider.credential_changed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.proposal_approved", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.proposal_rejected", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.strength_changed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.fact_superseded", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.fact_forgotten", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.memory.fact_suppressed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.plugin.permission_granted", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.plugin.permission_denied", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.plugin.permission_revoked", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.observability.preferences_changed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.observability.retention_executed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.observability.export_created", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "point", significance: "notable" }),
      entry({ eventName: "audit.observability.ledger_reset", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "milestone" }),
    ] as EventCatalogEntry[]
  ).map((item) => [item.eventName, item] as const),
);

export function getCatalogEntry(eventName: string, eventVersion?: number): EventCatalogEntry | undefined {
  const item = ObservabilityEventCatalog.get(eventName);
  if (item === undefined) return undefined;
  if (eventVersion !== undefined && eventVersion !== item.eventVersion) return undefined;
  return item;
}
