import type { EventCatalogEntry } from "../../contracts/observability.js";
import { entry, notable, routine } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 Skill 事件目录（plans/phase-13.md §13.2，T1 冻结）
//
// - activity 事件：点号式（skill.install.started 等），用于时间线/UI；
// - audit 事件：下划线式（audit.skill.install_started/completed/failed 三件套），
//   文件型/持久型操作（安装、绑定、解绑、回滚、选择变更、Bundle 版本化、来源信任）
//   必须走 Phase 11 严格审计生命周期（started → 领域事务 → completed/failed）；
// - 事件只记录 skillRefKey / bundleRef / sourceId / contentHash / agentId /
//   sessionId / turnId / operationId 与稳定 reasonCode、大小摘要——不记录 Skill 正文；
// - 高频读取事件以 Trace/Diagnostic 为主（读取本身不落 Durable Activity，
//   只有拒绝/失败/脚本执行结果进入）。
// ═══════════════════════════════════════════════════════════════

/** Phase 13 Skill activity 事件（点号式，时间线/UI 证据） */
export const skillActivityEntries: readonly EventCatalogEntry[] = [
  // ── 来源发现 / 检查 ──
  entry({ eventName: "skill.discovered", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "skill.inspect.started", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...routine }),
  entry({ eventName: "skill.inspect.completed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "skill.inspect.failed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),

  // ── 安装 / 风险审查 / 确认 ──
  entry({ eventName: "skill.install.started", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...notable, auditMirror: "audit.skill.install_started" }),
  entry({ eventName: "skill.install.completed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.skill.install_completed" }),
  entry({ eventName: "skill.install.failed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable, auditMirror: "audit.skill.install_failed" }),
  entry({ eventName: "skill.install.risk_detected", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.install.confirmation_requested", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.install.confirmed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.install.rejected", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── 绑定 / 解绑 / 选择 / 状态 ──
  entry({ eventName: "skill.bound", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.binding_change_completed" }),
  entry({ eventName: "skill.unbound.requested", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.unbound.approved", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.binding_change_completed" }),
  entry({ eventName: "skill.unbound.rejected", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.selection.changed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.binding_change_completed" }),
  entry({ eventName: "skill.blocked", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.shadowed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "skill.readiness.changed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...routine }),

  // ── 正文读取 / 脚本 ──
  entry({ eventName: "skill.read.started", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...routine }),
  entry({ eventName: "skill.read.completed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "skill.read.failed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
  entry({ eventName: "skill.script.started", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "denied"], ...routine }),
  entry({ eventName: "skill.script.completed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "skill.script.failed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
  entry({ eventName: "skill.script.denied", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["denied"], ...notable }),

  // ── 卸载 / 回滚 / Bundle ──
  entry({ eventName: "skill.uninstalled", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.uninstall_completed" }),
  entry({ eventName: "skill.rollback.started", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...notable, auditMirror: "audit.skill.rollback_started" }),
  entry({ eventName: "skill.rollback.completed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.skill.rollback_completed" }),
  entry({ eventName: "skill.rollback.failed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable, auditMirror: "audit.skill.rollback_failed" }),
  entry({ eventName: "skill.bundle.created", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.bundle_change_completed" }),
  entry({ eventName: "skill.bundle.versioned", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.bundle_change_completed" }),
  entry({ eventName: "skill.bundle.migrated", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.binding_change_completed" }),
  entry({ eventName: "skill.bundle.rolled_back", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.skill.rollback_completed" }),

  // ── 激活授权（Session 内安装即时生效）──
  entry({ eventName: "skill.activation.granted", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.activation.consumed", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  // T13（P1）：补偿撤销事件注册——ActivityRecorder 未登记的事件会 rejected 且
  // 证据静默丢失（loadHandle 失败补偿撤销 grant 的审计证据必须落库）
  entry({ eventName: "skill.activation.revoked", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
  entry({ eventName: "skill.activation.expired", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...routine }),
  entry({ eventName: "skill.activation.rejected", eventVersion: 1, channel: "activity", category: "skill", defaultLevel: "warn", lifecycleRole: "point", ...notable }),
];

/** Phase 13 Skill 严格审计事件（下划线式生命周期，§13.2 要求 1） */
export const skillAuditEntries: readonly EventCatalogEntry[] = [
  entry({ eventName: "audit.skill.install_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.install_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.install_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.update_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.update_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.update_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.rollback_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.rollback_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.rollback_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.uninstall_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.uninstall_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.uninstall_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.binding_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.binding_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.binding_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.bundle_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.bundle_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.bundle_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.source_trust_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.skill.source_trust_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.source_trust_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.skill.operation_recovered", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
];
