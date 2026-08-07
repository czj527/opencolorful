import type { EventCatalogEntry } from "../../contracts/observability.js";
import { entry, notable, routine } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 Subagent 事件目录（plans/phase-14.md §19.2 / §19.3）
//
// 命名约定（T1 冻结，不得新旧混用）：
// - activity 事件：点号式（subagent.thread.created / subagent.run.completed）；
// - audit 生命周期事件：下划线式（audit.subagent.spawn_started /
//   audit.subagent.spawn_completed / audit.subagent.spawn_failed）；
// - 生命周期事件按 lifecycleRole 约定：started 带 terminalStatuses，
//   terminal 自带终态；关键状态（委派/写权限/取消/关闭）用 ...notable，
//   高频执行/心跳用 ...routine；
// - subagent.run.progress 按里程碑写（reporting.progress=milestones）或同一
//   Run 限频 ≥ 30 秒一条；高频阶段/工具状态只走 SSE 面板流，不落 durable；
// - 日志 payload 只记录 ID/哈希/count/reasonCode，不记录 TaskBrief/Prompt/
//   结果正文/transcript（§19.3 / §25.7）。
// ═══════════════════════════════════════════════════════════════

/** Phase 14 Subagent Activity 事件 */
export const subagentActivityEntries: readonly EventCatalogEntry[] = [
  // ── Thread 生命周期（关键状态，notable）──
  entry({ eventName: "subagent.thread.created", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.spawn_completed" }),
  entry({ eventName: "subagent.thread.closing", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.close_started" }),
  entry({ eventName: "subagent.thread.closed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.subagent.close_completed" }),

  // ── Run 生命周期（terminal 唯一；progress 限频）──
  // ActivityStatus 无 timed_out/budget_exhausted（沿用 plugin.execution.* 先例：
  // 事件 status 用 failed/interrupted，Run 状态机保持原枚举，reasonCode 区分）
  entry({ eventName: "subagent.run.queued", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "subagent.run.started", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...notable }),
  entry({ eventName: "subagent.run.progress", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "progress", ...routine }),
  entry({ eventName: "subagent.run.input_required", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "subagent.run.completed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.subagent.spawn_completed" }),
  entry({ eventName: "subagent.run.failed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "subagent.run.cancelled", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...notable, auditMirror: "audit.subagent.cancel_completed" }),
  entry({ eventName: "subagent.run.timed_out", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "subagent.run.interrupted", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["interrupted"], ...notable }),
  entry({ eventName: "subagent.run.budget_exhausted", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

  // ── 纠偏（关键状态，notable）──
  entry({ eventName: "subagent.steer.queued", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "subagent.steer.applied", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "subagent.steer.failed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── 协议消息（高频，routine；payload 只记录 id/type/sequence 摘要）──
  entry({ eventName: "subagent.message.queued", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "subagent.message.delivered", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...routine }),

  // ── Parent Mailbox 投递（关键状态，notable；高频限频）──
  entry({ eventName: "subagent.parent_delivery.queued", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "subagent.parent_delivery.completed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),
  entry({ eventName: "subagent.parent_delivery.failed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "subagent.parent_delivery.suppressed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "point", ...routine }),

  // ── 能力快照（安全证据，notable）──
  entry({ eventName: "subagent.snapshot.created", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.capability_delegation_completed" }),
  entry({ eventName: "subagent.snapshot.rejected", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.capability_delegation_failed" }),

  // ── Runtime Lease（routine）──
  entry({ eventName: "subagent.runtime.lease_acquired", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "subagent.runtime.lease_lost", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "point", ...routine }),

  // ── 工作区写 Lease（关键状态，notable）──
  entry({ eventName: "subagent.workspace_lease.acquired", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.workspace_write_completed" }),
  entry({ eventName: "subagent.workspace_lease.released", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "subagent.workspace_lease.denied", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── Artifact（关键状态，notable）──
  entry({ eventName: "subagent.artifact.created", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.artifact_access_completed" }),
  entry({ eventName: "subagent.artifact.integrity_failed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "error", lifecycleRole: "point", ...notable, auditMirror: "audit.subagent.artifact_access_failed" }),

  // ── 启动恢复（关键状态，notable）──
  entry({ eventName: "subagent.recovery.completed", eventVersion: 1, channel: "activity", category: "subagent", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed", "degraded"], ...notable }),
];

/** Phase 14 Subagent 严格审计事件（下划线式三阶段生命周期，§19.3） */
export const subagentAuditEntries: readonly EventCatalogEntry[] = [
  entry({ eventName: "audit.subagent.spawn_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.spawn_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.spawn_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.capability_delegation_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.capability_delegation_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.capability_delegation_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.workspace_write_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.workspace_write_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.workspace_write_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.artifact_access_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.artifact_access_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.artifact_access_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.cancel_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.cancel_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.cancel_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.close_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.subagent.close_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.subagent.close_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
];
