import type { EventCatalogEntry } from "../../contracts/observability.js";
import { entry, notable, routine } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 插件事件目录（plans/phase-12.md §17.2 / §17.3）
//
// 命名约定（T1 冻结，不得新旧混用）：
// - activity 事件：点号式（plugin.installed / plugin.execution.completed）；
// - audit 生命周期事件：下划线式（audit.plugin.install_started /
//   audit.plugin.install_completed / audit.plugin.install_failed）；
// - 生命周期事件按 lifecycleRole 约定：started 带 terminalStatuses，
//   completed/failed/cancelled/timed_out/interrupted 为 terminal；
// - 关键状态（安装/更新/回滚/卸载/权限）用 ...notable，高频执行/进程用 ...routine；
// - plugin.execution.* 通过 payload.contributionKind 区分 tool/command/provider/
//   route/hook/background/surface，不为每类建设平行生命周期。
//
// 插件自定义事件只能使用 plugin.<pluginId>.<domain>.<action> 命名空间，
// 默认 routine + producerPolicy "extension-allowed"，不能自行生成 Audit、
// notable 或 milestone（见 ExtensionObservabilityPort）。
// ═══════════════════════════════════════════════════════════════

/** Phase 12 插件 Activity 事件（Phase 11 基础 + Phase 12 扩展） */
export const pluginActivityEntries: readonly EventCatalogEntry[] = [
  // ── Phase 11 已注册基础事件（保持兼容，不许改名）──
  entry({ eventName: "plugin.permission.granted", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_granted" }),
  entry({ eventName: "plugin.permission.denied", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_denied" }),
  entry({ eventName: "plugin.permission.revoked", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.permission_revoked" }),
  entry({ eventName: "plugin.crashed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),

  // ── 安装/生命周期状态（关键状态，notable）──
  entry({ eventName: "plugin.discovered", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "plugin.staged", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "plugin.installed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.install_completed" }),
  entry({ eventName: "plugin.updated", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.update_completed" }),
  entry({ eventName: "plugin.rollback.started", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed"], ...notable }),
  entry({ eventName: "plugin.rollback.completed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable, auditMirror: "audit.plugin.rollback_completed" }),
  entry({ eventName: "plugin.rollback.failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "plugin.enabled", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "plugin.disabled", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "plugin.uninstalled", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable, auditMirror: "audit.plugin.uninstall_completed" }),
  entry({ eventName: "plugin.degraded", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── 进程生命周期（高频，routine）──
  entry({ eventName: "plugin.process.started", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "interrupted"], ...routine }),
  entry({ eventName: "plugin.process.exited", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "plugin.process.crashed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
  entry({ eventName: "plugin.process.restarted", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...routine }),

  // ── 执行生命周期（高频，routine；payload.contributionKind 区分类型）──
  entry({ eventName: "plugin.execution.started", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "started", terminalStatuses: ["completed", "failed", "cancelled", "interrupted"], ...routine }),
  entry({ eventName: "plugin.execution.completed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "plugin.execution.failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
  entry({ eventName: "plugin.execution.cancelled", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["cancelled"], ...routine }),
  entry({ eventName: "plugin.execution.timed_out", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...routine }),
  entry({ eventName: "plugin.execution.interrupted", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["interrupted"], ...routine }),

  // ── 权限（责任证据，notable）──
  entry({ eventName: "plugin.permission.requested", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  // plugin.permission.granted / denied / revoked 已在 Phase 11 注册（含 audit 镜像）

  // ── 操作恢复（启动时中断操作终结为 failed，notable）──
  entry({ eventName: "plugin.operation.recovered", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...notable }),

  // ── 完整性 / 沙箱拒绝（安全证据，notable）──
  entry({ eventName: "plugin.integrity.failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "plugin.sandbox.denied", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── Surface（UI 边界，notable 关键状态 / routine 常规）──
  entry({ eventName: "plugin.surface.opened", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...routine }),
  entry({ eventName: "plugin.surface.failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "plugin.surface.capability_denied", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "point", ...notable }),

  // ── 来源（Source Adapter 边界）──
  entry({ eventName: "plugin.source.fetch_failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
  entry({ eventName: "plugin.source.quarantined", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "warn", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),

  // ── Dev Loop（开发态，notable 关键状态）──
  entry({ eventName: "plugin.dev.installed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "plugin.dev.reloaded", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "point", ...notable }),
  entry({ eventName: "plugin.dev.scenario_completed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "info", lifecycleRole: "terminal", terminalStatuses: ["completed"], ...routine }),
  entry({ eventName: "plugin.dev.scenario_failed", eventVersion: 1, channel: "activity", category: "plugin", defaultLevel: "error", lifecycleRole: "terminal", terminalStatuses: ["failed"], ...notable }),
];

/** Phase 12 插件严格审计事件（下划线式生命周期，plans/phase-12.md §17.3） */
export const pluginAuditEntries: readonly EventCatalogEntry[] = [
  entry({ eventName: "audit.plugin.install_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.install_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.install_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.update_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.update_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.update_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.rollback_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.rollback_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.rollback_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.uninstall_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.uninstall_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.uninstall_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.permission_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.permission_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.permission_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.agent_binding_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.agent_binding_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.agent_binding_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.config_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.config_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.config_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.secret_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.secret_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.secret_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.source_trust_change_started", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "started", significance: "notable" }),
  entry({ eventName: "audit.plugin.source_trust_change_completed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "info", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.source_trust_change_failed", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "terminal", significance: "notable" }),
  entry({ eventName: "audit.plugin.operation_recovered", eventVersion: 1, channel: "audit", category: "audit", defaultLevel: "warn", lifecycleRole: "point", significance: "notable" }),
];
