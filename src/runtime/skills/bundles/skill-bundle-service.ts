import crypto from "node:crypto";
import fs from "node:fs";

import type { RuntimePaths } from "../../../config/paths.js";
import type { ActorRef, EventScope, ExecutorRef, ResourceRef, TraceContext } from "../../../contracts/observability.js";
import { skillRefKey, type BundleRef, type SkillRef, type SkillSelectionMode, type SkillSourceKind } from "../../../contracts/skill-protocol.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import { runStrictAuditLifecycle } from "../../plugins/contributions/shared.js";
import type { AgentSkillBindingStore } from "../../../storage/agent-skill-binding-store.js";
import { SKILL_HASH_PREFIX } from "../hash.js";
import type { SkillOperationStore } from "../installer/operation-store.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError } from "../errors.js";
import type { AgentSkillConfig, AgentSkillConfigStore } from "../agent/agent-skill-config.js";
import type { BundleVersionRecord, SkillBundleStore } from "../../../storage/skill-bundle-store.js";
import type { AgentSkillBundleBinding } from "../agent/agent-skill-config.js";
import { buildBindingRows, resolveAllBundleItems } from "../binding/projection.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Skill Bundle 服务（plans/phase-13.md §9.3 / §11.6 / §13.2）
//
// - Bundle 是版本化 SkillRef 集合：变更必须创建新版本（version 自增 + 新
//   contentHash），**不原地覆盖旧版本**，旧版本保持可回滚；
// - contentHash 由 items + name + source 计算（bundleId 不参与）；
// - 创建/版本化走严格审计（audit.skill.bundle_change_*）；Agent 绑定/
//   迁移走 audit.skill.binding_change_*；回滚走 audit.skill.rollback_*；
// - bindBundleToAgent / migrateBundle / rollbackBundle：写 skills.json
//   （原子）→ 重建投影（同一审计事务）→ 严格审计，审计失败领域回滚；
// - migrateBundle 保留旧绑定（旧版本仍在 Store 可回滚）并把迁移前后差异
//   （before/after revision + 变更字段）写入审计与 activity 属性。
// ═══════════════════════════════════════════════════════════════

export interface SkillBundleServiceDeps {
  readonly paths: RuntimePaths;
  readonly bundles: SkillBundleStore;
  readonly catalog: SkillCatalog;
  readonly configStore: AgentSkillConfigStore;
  readonly bindingStore: AgentSkillBindingStore;
  readonly audit: AuditRecorder;
  readonly operations?: SkillOperationStore;
  readonly now?: () => Date;
}

export interface BundleItemInput {
  readonly skillRef: SkillRef;
  readonly selection?: SkillSelectionMode;
  readonly ordinal?: number;
}

export interface CreateBundleInput {
  readonly bundleId: string;
  readonly name: string;
  readonly items: readonly BundleItemInput[];
  readonly sourceKind: SkillSourceKind;
  readonly sourceId: string;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export interface BundleResolveResult {
  readonly bundle: BundleVersionRecord;
  readonly resolved: readonly ResolvedBundleItemView[];
  readonly missing: readonly string[];
}

export interface ResolvedBundleItemView {
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly ordinal: number;
}

export interface BindBundleInput {
  readonly agentId: string;
  readonly bundleId: string;
  readonly version: string;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export interface MigrateBundleInput {
  readonly agentId: string;
  /** 迁移前绑定（from.bundleId 必须与 to.bundleId 一致） */
  readonly from: BundleRef;
  readonly to: BundleRef;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export interface RollbackBundleInput {
  readonly agentId: string;
  readonly bundleId: string;
  readonly targetVersion: string;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export interface BundleBindingResult {
  readonly agentId: string;
  readonly bundleId: string;
  readonly version: string;
  readonly configRevision: number;
  readonly updatedAt: string;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-bundles" };
const PERSISTED_SELECTIONS = new Set<SkillSelectionMode>(["implicit", "explicit-only", "disabled"]);
const BUNDLE_HASH_HEX_LENGTH = 57;

export class SkillBundleService {
  private readonly now: () => Date;

  constructor(private readonly deps: SkillBundleServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── Bundle 版本化 ─────────────────────────────────────────────

  /**
   * 创建 Bundle 新版本（首个版本 = "1"，之后自增；旧版本保留）。
   * 每个 item 的 SkillRef 必须能在 Catalog 精确解析（fail-closed，不保存名称）。
   */
  createBundle(input: CreateBundleInput): BundleVersionRecord {
    this.validateBundleId(input.bundleId);
    if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 128) {
      throw new SkillError("skill_operation_failed", "Bundle 名称不合法");
    }
    const items = this.validateAndResolveItems(input.items);
    const version = this.deps.bundles.nextVersion(input.bundleId);
    const previous = this.deps.bundles.latestVersion(input.bundleId);
    const contentHash = computeBundleContentHash(input.name, input.sourceKind, input.sourceId, items);
    const createdAt = this.now().toISOString();
    const isFirstVersion = previous === null;

    const operationId = `skill-bundle-${input.bundleId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace: TraceContext = { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
    const scope: EventScope = { ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) };

    try {
      runStrictAuditLifecycle(
        {
          audit: this.deps.audit,
          trace,
          actor: input.actor,
          executor: EXECUTOR,
          target: { kind: "external_resource", id: `bundle:${input.bundleId}@${version}` },
          scope,
          startEventName: "audit.skill.bundle_change_started",
          completedEventName: "audit.skill.bundle_change_completed",
          failedEventName: "audit.skill.bundle_change_failed",
          action: isFirstVersion ? "skill.bundle.create" : "skill.bundle.version",
          beforeRevision: previous === null ? "0" : `bundle:${previous.bundleId}@${previous.version}`,
          afterRevision: `bundle:${input.bundleId}@${version}`,
          changedFields: ["bundleId", "version", "contentHash", "items"],
        },
        () => {
          this.deps.bundles.insertBundleVersion({
            bundleId: input.bundleId,
            version,
            contentHash,
            name: input.name,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            createdAt,
            ...(previous !== null ? { supersedesVersion: previous.version } : {}),
            items: items.map((item) => ({
              skillRefKey: item.skillRefKey,
              selection: item.selection,
              ordinal: item.ordinal,
            })),
          });
        },
      );
      const record = this.deps.bundles.getBundle(input.bundleId, version);
      if (record === null) {
        throw new SkillError("skill_operation_failed", "Bundle 版本写入后读取失败");
      }
      this.emitActivity(isFirstVersion ? "skill.bundle.created" : "skill.bundle.versioned", input.bundleId, input.sessionId, {
        bundleId: input.bundleId,
        version,
        contentHash: contentHash.slice(0, 24),
        itemCount: items.length,
      }, operationId);
      return record;
    } catch (error) {
      // 失败不冒充成功（activity 无 failed 变体；审计 failed 终态由严格生命周期保证）
      throw error;
    }
  }

  listBundleVersions(bundleId: string): BundleVersionRecord[] {
    this.validateBundleId(bundleId);
    return this.deps.bundles.listVersions(bundleId);
  }

  getBundle(bundleId: string, version: string): BundleVersionRecord | null {
    this.validateBundleId(bundleId);
    return this.deps.bundles.getBundle(bundleId, version);
  }

  /** 解析 Bundle 版本的精确 SkillRef（contentHash 只能来自 Catalog；缺失 → missing）。 */
  resolveBundleRefs(bundleId: string, version: string): BundleResolveResult {
    this.validateBundleId(bundleId);
    const bundle = this.deps.bundles.getBundle(bundleId, version);
    if (bundle === null) {
      throw new SkillError("skill_unknown_skillref", `Bundle 版本不存在：${bundleId}@${version}`);
    }
    return this.resolveVersion(bundle);
  }

  // ── Agent 绑定 / 迁移 / 回滚 ─────────────────────────────────

  /** 绑定 Bundle 版本到 Agent：写 skills.json → 投影 → 严格审计（固定版本，pinned）。 */
  bindBundleToAgent(input: BindBundleInput): BundleBindingResult {
    this.validateAgentId(input.agentId);
    this.validateBundleId(input.bundleId);
    const bundle = this.deps.bundles.getBundle(input.bundleId, input.version);
    if (bundle === null) {
      throw new SkillError("skill_unknown_skillref", `Bundle 版本不存在：${input.bundleId}@${input.version}`);
    }
    const { missing } = this.resolveVersion(bundle);
    if (missing.length > 0) {
      throw new SkillError("skill_unknown_skillref", `Bundle 包含无法解析的 SkillRef（${missing.join("、")}），fail-closed 拒绝绑定`);
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    const existing = config.bundleBindings.find((binding) => binding.bundleId === input.bundleId);
    const nextBindings: AgentSkillBundleBinding[] = existing === undefined
      ? [...config.bundleBindings, { bundleId: input.bundleId, version: input.version, pinned: true }]
      : config.bundleBindings.map((binding) =>
          binding.bundleId === input.bundleId ? { bundleId: input.bundleId, version: input.version, pinned: true } : binding,
        );
    const nextConfig: AgentSkillConfig = { ...config, bundleBindings: nextBindings, updatedAt: this.now().toISOString() };
    const revision = this.deps.bindingStore.maxRevision(input.agentId) + 1;

    this.commitAgentBindingChange({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.bundle.bind",
      beforeRevision: String(revision - 1),
      afterRevision: String(revision),
      changedFields: ["bundleBindings"],
      target: { kind: "external_resource", id: `bundle:${input.bundleId}@${input.version}` },
      operation: { kind: "bind", sourceRef: `bundle:${input.bundleId}@${input.version}` },
      activity: {
        eventName: "skill.bound",
        attributes: { bundleId: input.bundleId, version: input.version, pinned: 1 },
      },
      nextConfig,
      revision,
      write: (config: AgentSkillConfig, revisionNumber: number) => {
        this.deps.configStore.saveSkillsConfig(input.agentId, config);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, config, revisionNumber));
      },
      rollbackFileFor: input.agentId,
    });
    return { agentId: input.agentId, bundleId: input.bundleId, version: input.version, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
  }

  /**
   * Bundle 迁移（固定版本升级）：保留旧绑定（旧版本仍可回滚），迁移前后差异
   * 写入审计 before/afterRevision 与 activity 属性。
   */
  migrateBundle(input: MigrateBundleInput): BundleBindingResult {
    this.validateAgentId(input.agentId);
    if (input.from.bundleId !== input.to.bundleId) {
      throw new SkillError("skill_operation_failed", "迁移前后必须属于同一 Bundle（跨 Bundle 请先解绑再绑定）");
    }
    const from = this.deps.bundles.getBundle(input.from.bundleId, input.from.version);
    if (from === null) {
      throw new SkillError("skill_unknown_skillref", `迁移源 Bundle 版本不存在：${input.from.bundleId}@${input.from.version}`);
    }
    const to = this.deps.bundles.getBundle(input.to.bundleId, input.to.version);
    if (to === null) {
      throw new SkillError("skill_unknown_skillref", `迁移目标 Bundle 版本不存在：${input.to.bundleId}@${input.to.version}`);
    }
    const { missing } = this.resolveVersion(to);
    if (missing.length > 0) {
      throw new SkillError("skill_unknown_skillref", `迁移目标包含无法解析的 SkillRef（${missing.join("、")}），fail-closed 拒绝迁移`);
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    if (!config.bundleBindings.some((binding) => binding.bundleId === input.from.bundleId && binding.version === input.from.version)) {
      throw new SkillError("skill_unknown_skillref", `Agent 未绑定迁移源版本：${input.from.bundleId}@${input.from.version}`);
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      bundleBindings: config.bundleBindings.map((binding) =>
        binding.bundleId === input.from.bundleId
          ? { bundleId: input.from.bundleId, version: input.to.version, pinned: true }
          : binding,
      ),
      updatedAt: this.now().toISOString(),
    };
    const revision = this.deps.bindingStore.maxRevision(input.agentId) + 1;
    const fromKeys = new Set(from.items.map((item) => item.skillRefKey));
    const toKeys = new Set(to.items.map((item) => item.skillRefKey));
    const added = [...toKeys].filter((key) => !fromKeys.has(key)).sort();
    const removed = [...fromKeys].filter((key) => !toKeys.has(key)).sort();

    this.commitAgentBindingChange({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.bundle.migrate",
      beforeRevision: `bundle:${input.from.bundleId}@${input.from.version}`,
      afterRevision: `bundle:${input.to.bundleId}@${input.to.version}`,
      changedFields: ["bundleBindings"],
      target: { kind: "external_resource", id: `bundle:${input.to.bundleId}@${input.to.version}` },
      activity: {
        eventName: "skill.bundle.migrated",
        // 精确 skillRefKey 含绝对路径会被可观测性安全层脱敏（[WIN_PATH]），
        // 差异以计数 + 审计 before/afterRevision（bundle:crew@1 → @2）承载
        attributes: {
          bundleId: input.to.bundleId,
          fromVersion: input.from.version,
          toVersion: input.to.version,
          addedCount: added.length,
          removedCount: removed.length,
        },
      },
      nextConfig,
      revision,
      write: (config: AgentSkillConfig, revisionNumber: number) => {
        this.deps.configStore.saveSkillsConfig(input.agentId, config);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, config, revisionNumber));
      },
      rollbackFileFor: input.agentId,
    });
    return { agentId: input.agentId, bundleId: input.to.bundleId, version: input.to.version, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
  }

  /** Bundle 回滚到目标版本（目标版本必须存在；旧版本保留可反复回滚）。 */
  rollbackBundle(input: RollbackBundleInput): BundleBindingResult {
    this.validateAgentId(input.agentId);
    this.validateBundleId(input.bundleId);
    const target = this.deps.bundles.getBundle(input.bundleId, input.targetVersion);
    if (target === null) {
      throw new SkillError("skill_rollback_failed", `回滚目标版本不存在：${input.bundleId}@${input.targetVersion}`);
    }
    const { missing } = this.resolveVersion(target);
    if (missing.length > 0) {
      throw new SkillError("skill_rollback_failed", `回滚目标包含无法解析的 SkillRef（${missing.join("、")}），fail-closed 拒绝回滚`);
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    const current = config.bundleBindings.find((binding) => binding.bundleId === input.bundleId);
    if (current === undefined) {
      throw new SkillError("skill_unknown_skillref", `Agent 未绑定该 Bundle：${input.bundleId}`);
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      bundleBindings: config.bundleBindings.map((binding) =>
        binding.bundleId === input.bundleId
          ? { bundleId: input.bundleId, version: input.targetVersion, pinned: true }
          : binding,
      ),
      updatedAt: this.now().toISOString(),
    };
    const revision = this.deps.bindingStore.maxRevision(input.agentId) + 1;
    const operationId = `skill-bundle-${input.bundleId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace: TraceContext = { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
    const scope: EventScope = { ownerAgentId: input.agentId, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) };

    try {
      runStrictAuditLifecycle(
        {
          audit: this.deps.audit,
          trace,
          actor: input.actor,
          executor: EXECUTOR,
          target: { kind: "external_resource", id: `bundle:${input.bundleId}@${input.targetVersion}` },
          scope,
          startEventName: "audit.skill.rollback_started",
          completedEventName: "audit.skill.rollback_completed",
          failedEventName: "audit.skill.rollback_failed",
          action: "skill.agent.bundle.rollback",
          beforeRevision: `bundle:${input.bundleId}@${current.version}`,
          afterRevision: `bundle:${input.bundleId}@${input.targetVersion}`,
          changedFields: ["bundleBindings"],
          rollback: () => this.restoreConfigFile(input.agentId),
        },
        () => {
          this.deps.operations?.startOperation({
            operationId,
            kind: "rollback",
            sourceRef: `bundle:${input.bundleId}@${input.targetVersion}`,
            agentId: input.agentId,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          });
          this.deps.configStore.saveSkillsConfig(input.agentId, nextConfig);
          this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, nextConfig, revision));
        },
      );
      this.deps.operations?.finishOperation(operationId, "completed");
      this.emitActivity("skill.bundle.rolled_back", input.bundleId, input.sessionId, {
        bundleId: input.bundleId,
        fromVersion: current.version,
        toVersion: input.targetVersion,
      }, operationId);
      return { agentId: input.agentId, bundleId: input.bundleId, version: input.targetVersion, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
    } catch (error) {
      this.deps.operations?.finishOperation(operationId, "failed", { errorCode: extractReasonCode(error) });
      throw error;
    }
  }

  /** 解绑 Bundle（Agent 不再使用该 Bundle 版本；需要用户确认，confirmed=false 拒绝）。 */
  unbindBundle(input: { readonly agentId: string; readonly bundleId: string; readonly confirmed: boolean; readonly actor: ActorRef; readonly sessionId?: string }): { readonly status: "confirmation_required" | "unbound"; readonly agentId: string; readonly bundleId: string; readonly configRevision?: number } {
    this.validateAgentId(input.agentId);
    this.validateBundleId(input.bundleId);
    if (!input.confirmed) {
      this.emitActivity("skill.unbound.requested", input.bundleId, input.sessionId, { bundleId: input.bundleId, reason: "需要用户确认后才能解绑 Bundle" });
      return { status: "confirmation_required", agentId: input.agentId, bundleId: input.bundleId };
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    if (!config.bundleBindings.some((binding) => binding.bundleId === input.bundleId)) {
      throw new SkillError("skill_unknown_skillref", `Agent 未绑定该 Bundle：${input.bundleId}`);
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      bundleBindings: config.bundleBindings.filter((binding) => binding.bundleId !== input.bundleId),
      updatedAt: this.now().toISOString(),
    };
    const revision = this.deps.bindingStore.maxRevision(input.agentId) + 1;
    this.commitAgentBindingChange({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.bundle.unbind",
      beforeRevision: String(revision - 1),
      afterRevision: String(revision),
      changedFields: ["bundleBindings"],
      target: { kind: "external_resource", id: `bundle:${input.bundleId}` },
      operation: { kind: "unbind", sourceRef: `bundle:${input.bundleId}` },
      activity: { eventName: "skill.unbound.approved", attributes: { bundleId: input.bundleId } },
      activityOnFailure: { eventName: "skill.unbound.rejected", attributes: { bundleId: input.bundleId } },
      nextConfig,
      revision,
      write: (config: AgentSkillConfig, revisionNumber: number) => {
        this.deps.configStore.saveSkillsConfig(input.agentId, config);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, config, revisionNumber));
      },
      rollbackFileFor: input.agentId,
    });
    return { status: "unbound", agentId: input.agentId, bundleId: input.bundleId, configRevision: revision };
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  private resolveVersion(bundle: BundleVersionRecord): BundleResolveResult {
    const candidates = this.deps.catalog.list({});
    const byRefKey = new Map<string, SkillRef>();
    for (const candidate of candidates) {
      byRefKey.set(skillRefKey(candidate.skillRef), candidate.skillRef);
    }
    const resolved: ResolvedBundleItemView[] = [];
    const missing: string[] = [];
    for (const item of bundle.items) {
      const skillRef = byRefKey.get(item.skillRefKey);
      if (skillRef === undefined) {
        missing.push(item.skillRefKey);
      } else {
        resolved.push({ skillRef, skillRefKey: item.skillRefKey, selection: item.selection, ordinal: item.ordinal });
      }
    }
    return { bundle, resolved, missing };
  }

  private validateAndResolveItems(items: readonly BundleItemInput[]): Array<{ readonly skillRef: SkillRef; readonly skillRefKey: string; readonly selection: SkillSelectionMode; readonly ordinal: number }> {
    if (items.length === 0) {
      throw new SkillError("skill_operation_failed", "Bundle 至少包含一个 Skill 项");
    }
    if (items.length > 256) {
      throw new SkillError("skill_operation_failed", "Bundle 项数量超出上限（256）");
    }
    const seen = new Set<string>();
    return items.map((item, index) => {
      const ref = this.deps.catalog.resolveBySkillRef(item.skillRef);
      const selection = item.selection ?? "implicit";
      if (!PERSISTED_SELECTIONS.has(selection)) {
        throw new SkillError("skill_operation_failed", `不支持的 Bundle 项选择模式：${String(selection)}`);
      }
      const key = skillRefKey(ref.skillRef);
      if (seen.has(key)) {
        throw new SkillError("skill_operation_failed", `Bundle 项重复：${key}`);
      }
      seen.add(key);
      return { skillRef: ref.skillRef, skillRefKey: key, selection, ordinal: item.ordinal ?? index };
    });
  }

  private commitAgentBindingChange(params: {
    readonly agentId: string;
    readonly actor: ActorRef;
    readonly sessionId?: string;
    readonly action: string;
    readonly beforeRevision: string;
    readonly afterRevision: string;
    readonly changedFields: readonly string[];
    readonly target: ResourceRef;
    readonly operation?: { readonly kind: "bind" | "unbind" | "rollback"; readonly sourceRef: string };
    readonly activity?: { readonly eventName: string; readonly attributes: Record<string, string | number | boolean> };
    readonly activityOnFailure?: { readonly eventName: string; readonly attributes: Record<string, string | number | boolean> };
    readonly nextConfig: AgentSkillConfig;
    readonly revision: number;
    readonly write: (config: AgentSkillConfig, revision: number) => void;
    readonly rollbackFileFor: string;
  }): void {
    const operationId = `skill-bundle-${params.agentId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace: TraceContext = { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
    const scope: EventScope = { ownerAgentId: params.agentId, ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}) };
    const fileSnapshot = previousFileSnapshot(this.deps.configStore.filePathFor(params.rollbackFileFor));

    try {
      runStrictAuditLifecycle(
        {
          audit: this.deps.audit,
          trace,
          actor: params.actor,
          executor: EXECUTOR,
          target: params.target,
          scope,
          startEventName: "audit.skill.binding_change_started",
          completedEventName: "audit.skill.binding_change_completed",
          failedEventName: "audit.skill.binding_change_failed",
          action: params.action,
          beforeRevision: params.beforeRevision,
          afterRevision: params.afterRevision,
          changedFields: [...params.changedFields],
          rollback: () => this.restoreConfigFile(params.rollbackFileFor, fileSnapshot),
        },
        () => {
          if (params.operation !== undefined && this.deps.operations !== undefined) {
            this.deps.operations.startOperation({
              operationId,
              kind: params.operation.kind,
              sourceRef: params.operation.sourceRef,
              agentId: params.agentId,
              ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
            });
          }
          params.write(params.nextConfig, params.revision);
        },
      );
      this.deps.operations?.finishOperation(operationId, "completed");
      if (params.activity !== undefined) {
        this.emitActivity(params.activity.eventName, params.agentId, params.sessionId, params.activity.attributes, operationId);
      }
    } catch (error) {
      this.deps.operations?.finishOperation(operationId, "failed", { errorCode: extractReasonCode(error) });
      if (params.activityOnFailure !== undefined) {
        this.emitActivity(params.activityOnFailure.eventName, params.agentId, params.sessionId, params.activityOnFailure.attributes, operationId);
      }
      throw error;
    }
  }

  private buildRows(agentId: string, config: AgentSkillConfig, revision: number) {
    const { resolved } = resolveAllBundleItems({ bundles: this.deps.bundles, catalog: this.deps.catalog, config });
    return buildBindingRows({
      agentId,
      config,
      bundleItems: resolved,
      configRevision: revision,
      updatedAt: config.updatedAt ?? this.now().toISOString(),
    });
  }

  private emitActivity(
    eventName: string,
    agentId: string,
    sessionId: string | undefined,
    attributes: Record<string, string | number | boolean>,
    operationId?: string,
  ): void {
    const scope: EventScope = { ownerAgentId: agentId, ...(sessionId !== undefined ? { sessionId } : {}) };
    instrument.activity({
      eventName,
      ...(operationId !== undefined ? { operationId } : {}),
      actor: { kind: "system", id: "skill-bundles" },
      executor: EXECUTOR,
      scope,
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }

  private restoreConfigFile(agentId: string, snapshot?: { readonly content: string | null }): void {
    const file = this.deps.configStore.filePathFor(agentId);
    const effective = snapshot ?? previousFileSnapshot(file);
    if (effective.content === null) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 补偿失败不掩盖原错误
      }
      return;
    }
    fs.writeFileSync(file, effective.content, "utf8");
  }

  private validateAgentId(agentId: string): void {
    if (typeof agentId !== "string" || agentId.length < 1 || agentId.length > 128) {
      throw new SkillError("skill_agent_unauthorized", "Agent ID 不合法");
    }
  }

  private validateBundleId(bundleId: string): void {
    if (typeof bundleId !== "string" || bundleId.length < 1 || bundleId.length > 128) {
      throw new SkillError("skill_operation_failed", "Bundle ID 不合法");
    }
  }
}

/** Bundle contentHash：items（skillRefKey+selection+ordinal）+ name + source，bundleId 不参与。 */
export function computeBundleContentHash(
  name: string,
  sourceKind: SkillSourceKind,
  sourceId: string,
  items: readonly { readonly skillRefKey: string; readonly selection: SkillSelectionMode; readonly ordinal: number }[],
): string {
  const hash = crypto.createHash("sha256");
  hash.update("name");
  hash.update("\0");
  hash.update(name);
  hash.update("\0");
  hash.update("source");
  hash.update("\0");
  hash.update(sourceKind);
  hash.update("\0");
  hash.update(sourceId);
  hash.update("\0");
  const sorted = [...items].sort((a, b) => (a.ordinal - b.ordinal) || (a.skillRefKey < b.skillRefKey ? -1 : a.skillRefKey > b.skillRefKey ? 1 : 0));
  for (const item of sorted) {
    hash.update("item");
    hash.update("\0");
    hash.update(item.skillRefKey);
    hash.update("\0");
    hash.update(item.selection);
    hash.update("\0");
    hash.update(String(item.ordinal));
    hash.update("\0");
  }
  const hex = hash.digest("hex");
  return `${SKILL_HASH_PREFIX}${hex.slice(0, BUNDLE_HASH_HEX_LENGTH)}`;
}

function previousFileSnapshot(file: string): { readonly content: string | null } {
  try {
    return { content: fs.readFileSync(file, "utf8") };
  } catch {
    return { content: null };
  }
}

function extractReasonCode(error: unknown): string {
  if (error instanceof SkillError) {
    return error.code;
  }
  return "skill_operation_failed";
}
