import crypto from "node:crypto";
import fs from "node:fs";

import type { RuntimePaths } from "../../../config/paths.js";
import type { ActorRef, EventScope, ExecutorRef, ResourceRef, TraceContext } from "../../../contracts/observability.js";
import { skillRefKey, type SkillRef, type SkillSelectionMode } from "../../../contracts/skill-protocol.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import { runStrictAuditLifecycle } from "../../plugins/contributions/shared.js";
import type { AgentSkillBindingStore } from "../../../storage/agent-skill-binding-store.js";
import type { SkillBundleStore } from "../../../storage/skill-bundle-store.js";
import type { SkillOperationStore } from "../installer/operation-store.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import type { ResolveOutput } from "../resolver.js";
import type { ReadinessEnvironment } from "../readiness.js";
import { SkillError, assertSkillRef } from "../errors.js";
import type {
  AgentSkillConfig,
  AgentSkillConfigStore,
  SkillLearningPolicy,
} from "../agent/agent-skill-config.js";
import { isValidSkillRefKey } from "../agent/agent-skill-config.js";
import type { AgentSkillBindingWriteInput } from "../../../storage/agent-skill-binding-store.js";
import type { ResolvedBundleItem } from "./projection.js";
import { buildBindingRows, resolveAllBundleItems } from "./projection.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Agent Skill 绑定服务（plans/phase-13.md §9.4 / §11.6 / §13.2）
//
// - agents/<agentId>/skills.json 是唯一事实来源；本服务每次绑定变更：
//   校验 → 写 skills.json（原子）→ 重建投影（同一审计事务）→ 严格审计；
// - 绑定/解绑/选择变更/学习策略变更走 Phase 11 严格审计三阶段
//   （audit.skill.binding_change_started/completed/failed，runStrictAuditLifecycle）；
//   审计未配置/拒绝 → 领域回滚（文件恢复 + 投影回滚），fail-closed；
// - pinned 语义：direct SkillRef 与 Bundle 引用一律 pinned=true（固定版本）；
// - Agent 自主管理边界：停用（disabled）、解绑、学习策略变更必须用户确认
//   （confirmed=false → confirmation_required，不做任何领域修改）；
// - Workspace Skill 不写入 skills.json（只有显式 bindSkill 进入）。
// ═══════════════════════════════════════════════════════════════

export interface AgentSkillServiceDeps {
  readonly paths: RuntimePaths;
  readonly catalog: SkillCatalog;
  readonly configStore: AgentSkillConfigStore;
  readonly bindingStore: AgentSkillBindingStore;
  readonly bundles: SkillBundleStore;
  readonly audit: AuditRecorder;
  readonly operations?: SkillOperationStore;
  readonly now?: () => Date;
}

export interface SkillBindingActor {
  readonly actor: ActorRef;
}

export interface BindSkillInput {
  readonly agentId: string;
  readonly skillRef: SkillRef;
  /** 绑定时的选择模式（缺省 implicit；覆盖写入 overrides） */
  readonly selection?: SkillSelectionMode;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export type BindSkillResult =
  | {
      readonly status: "bound";
      readonly agentId: string;
      readonly skillRef: SkillRef;
      readonly skillRefKey: string;
      readonly selection: SkillSelectionMode;
      readonly pinned: true;
      readonly configRevision: number;
      readonly updatedAt: string;
    }
  | { readonly status: "already_pinned"; readonly agentId: string; readonly skillRefKey: string };

export interface UnbindSkillInput {
  readonly agentId: string;
  readonly skillRefKey: string;
  readonly confirmed: boolean;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export type UnbindSkillResult =
  | { readonly status: "confirmation_required"; readonly agentId: string; readonly skillRefKey: string; readonly reason: string }
  | { readonly status: "unbound"; readonly agentId: string; readonly skillRefKey: string; readonly configRevision: number; readonly updatedAt: string };

export interface SetSelectionInput {
  readonly agentId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly confirmed: boolean;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export type SetSelectionResult =
  | { readonly status: "confirmation_required"; readonly agentId: string; readonly skillRefKey: string; readonly reason: string }
  | { readonly status: "changed"; readonly agentId: string; readonly skillRefKey: string; readonly selection: SkillSelectionMode; readonly configRevision: number; readonly updatedAt: string };

export interface SetLearningPolicyInput {
  readonly agentId: string;
  readonly policy: SkillLearningPolicy;
  readonly confirmed: boolean;
  readonly actor: ActorRef;
  readonly sessionId?: string;
}

export type SetLearningPolicyResult =
  | { readonly status: "confirmation_required"; readonly agentId: string; readonly reason: string }
  | { readonly status: "changed"; readonly agentId: string; readonly policy: SkillLearningPolicy; readonly configRevision: number; readonly updatedAt: string };

export interface AgentSkillsView extends ResolveOutput {
  /** skills.json 原始视图（T6/T8 管理页展示与二次确认用） */
  readonly bindings: AgentSkillConfig;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-agent-bindings" };
const PERSISTED_SELECTIONS = new Set<SkillSelectionMode>(["implicit", "explicit-only", "disabled"]);

type PersistedSelection = "implicit" | "explicit-only" | "disabled";

function assertPersistedSelection(selection: SkillSelectionMode): asserts selection is PersistedSelection {
  if (!PERSISTED_SELECTIONS.has(selection)) {
    throw new SkillError("skill_operation_failed", `不支持的选择模式：${String(selection)}`);
  }
}

export class AgentSkillService {
  private readonly now: () => Date;

  constructor(private readonly deps: AgentSkillServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── 绑定 ─────────────────────────────────────────────────────

  /** 绑定精确 SkillRef 到 Agent：Catalog 校验 → skills.json → 投影 → 严格审计。 */
  bindSkill(input: BindSkillInput): BindSkillResult {
    this.validateAgentId(input.agentId);
    const ref = assertSkillRef(input.skillRef);
    // Catalog 精确解析（含 contentHash）：缺失 fail-closed，不允许绑定未知引用
    const registered = this.deps.catalog.resolveBySkillRef(ref);
    const skillRefKeyOf = skillRefKey(registered.skillRef);
    const selection = input.selection ?? "implicit";
    assertPersistedSelection(selection);

    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    if (config.directSkillRefs.some((existing) => skillRefKey(existing) === skillRefKeyOf)) {
      // 已固定同一精确引用：幂等（不重复写入、不产生变更审计）
      return { status: "already_pinned", agentId: input.agentId, skillRefKey: skillRefKeyOf };
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      directSkillRefs: [...config.directSkillRefs, registered.skillRef],
      overrides: { ...config.overrides, [skillRefKeyOf]: selection },
      updatedAt: this.now().toISOString(),
    };
    const revision = this.nextRevision(input.agentId);
    const beforeRevision = String(revision - 1);

    const result = this.commitStrict({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.binding.bind",
      beforeRevision,
      afterRevision: String(revision),
      changedFields: ["directSkillRefs", "overrides"],
      target: { kind: "external_resource", id: `skill:${skillRefKeyOf}` },
      operation: { kind: "bind", sourceRef: skillRefKeyOf },
      activity: {
        eventName: "skill.bound",
        attributes: { skillRefKey: skillRefKeyOf, skillId: registered.skillId, version: registered.version },
      },
      write: () => {
        this.deps.configStore.saveSkillsConfig(input.agentId, nextConfig);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, nextConfig, revision));
        return undefined;
      },
    });
    void result;
    return {
      status: "bound",
      agentId: input.agentId,
      skillRef: registered.skillRef,
      skillRefKey: skillRefKeyOf,
      selection,
      pinned: true,
      configRevision: revision,
      updatedAt: nextConfig.updatedAt as string,
    };
  }

  /** 解绑：confirmed=false → confirmation_required（不做领域修改）。 */
  unbindSkill(input: UnbindSkillInput): UnbindSkillResult {
    this.validateAgentId(input.agentId);
    if (!isValidSkillRefKey(input.skillRefKey)) {
      throw new SkillError("skill_unknown_skillref", "skillRefKey 格式非法");
    }
    if (!input.confirmed) {
      this.emitActivity("skill.unbound.requested", input.agentId, input.sessionId, {
        skillRefKey: input.skillRefKey,
        reason: "需要用户确认后才能解绑",
      });
      return { status: "confirmation_required", agentId: input.agentId, skillRefKey: input.skillRefKey, reason: "解绑需要用户确认（Agent 不得无确认持久解绑）" };
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    const key = input.skillRefKey;
    if (!config.directSkillRefs.some((existing) => skillRefKey(existing) === key)) {
      throw new SkillError("skill_unknown_skillref", `Agent 未绑定该直接 SkillRef：${key}`);
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      directSkillRefs: config.directSkillRefs.filter((existing) => skillRefKey(existing) !== key),
      overrides: removeOverride(config.overrides, key),
      updatedAt: this.now().toISOString(),
    };
    const revision = this.nextRevision(input.agentId);

    this.commitStrict({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.binding.unbind",
      beforeRevision: String(revision - 1),
      afterRevision: String(revision),
      changedFields: ["directSkillRefs", "overrides"],
      target: { kind: "external_resource", id: `skill:${key}` },
      operation: { kind: "unbind", sourceRef: key },
      activity: {
        eventName: "skill.unbound.approved",
        attributes: { skillRefKey: key },
      },
      activityOnFailure: {
        eventName: "skill.unbound.rejected",
        attributes: { skillRefKey: key },
      },
      write: () => {
        this.deps.configStore.saveSkillsConfig(input.agentId, nextConfig);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, nextConfig, revision));
      },
    });
    return { status: "unbound", agentId: input.agentId, skillRefKey: key, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
  }

  /**
   * 设置单 Skill 选择模式（overrides）。
   * - 三模式：implicit / explicit-only / disabled；
   * - disabled（持久停用）需要用户确认，否则返回 confirmation_required；
   * - 目标必须是已绑定直接引用、已消费的 override 键或 Catalog 中可解析的候选。
   */
  setSelection(input: SetSelectionInput): SetSelectionResult {
    this.validateAgentId(input.agentId);
    const selection = input.selection;
    assertPersistedSelection(selection);
    if (!isValidSkillRefKey(input.skillRefKey)) {
      throw new SkillError("skill_unknown_skillref", "skillRefKey 格式非法");
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    this.assertSelectionTarget(input.agentId, config, input.skillRefKey);
    if (selection === "disabled" && !input.confirmed) {
      this.emitActivity("skill.unbound.requested", input.agentId, input.sessionId, {
        skillRefKey: input.skillRefKey,
        reason: "disabled 选择变更需要用户确认",
      });
      return { status: "confirmation_required", agentId: input.agentId, skillRefKey: input.skillRefKey, reason: "停用 Skill 需要用户确认（Agent 不得无确认持久停用）" };
    }
    const nextConfig: AgentSkillConfig = {
      ...config,
      overrides: { ...config.overrides, [input.skillRefKey]: selection },
      updatedAt: this.now().toISOString(),
    };
    const revision = this.nextRevision(input.agentId);

    this.commitStrict({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.selection.change",
      beforeRevision: String(revision - 1),
      afterRevision: String(revision),
      changedFields: ["overrides"],
      target: { kind: "external_resource", id: `skill:${input.skillRefKey}` },
      activity: {
        eventName: "skill.selection.changed",
        attributes: { skillRefKey: input.skillRefKey, selection: input.selection },
      },
      write: () => {
        this.deps.configStore.saveSkillsConfig(input.agentId, nextConfig);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, nextConfig, revision));
      },
    });
    return { status: "changed", agentId: input.agentId, skillRefKey: input.skillRefKey, selection: input.selection, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
  }

  // ── 学习策略 ─────────────────────────────────────────────────

  getLearningPolicy(agentId: string): SkillLearningPolicy {
    this.validateAgentId(agentId);
    return this.deps.configStore.getSkillsConfig(agentId).learningPolicy;
  }

  /** 学习策略变更需要用户确认（confirmed=false → confirmation_required）。 */
  setLearningPolicy(input: SetLearningPolicyInput): SetLearningPolicyResult {
    this.validateAgentId(input.agentId);
    if (!input.confirmed) {
      return { status: "confirmation_required", agentId: input.agentId, reason: "学习策略变更需要用户确认" };
    }
    const config = this.deps.configStore.getSkillsConfig(input.agentId);
    if (config.learningPolicy === input.policy) {
      return { status: "changed", agentId: input.agentId, policy: input.policy, configRevision: this.deps.bindingStore.maxRevision(input.agentId), updatedAt: config.updatedAt ?? this.now().toISOString() };
    }
    const nextConfig: AgentSkillConfig = { ...config, learningPolicy: input.policy, updatedAt: this.now().toISOString() };
    const revision = this.nextRevision(input.agentId);

    this.commitStrict({
      agentId: input.agentId,
      actor: input.actor,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      action: "skill.agent.learning_policy.change",
      beforeRevision: String(revision - 1),
      afterRevision: String(revision),
      changedFields: ["learningPolicy"],
      target: { kind: "configuration", id: `agent:${input.agentId}:skills.json` },
      write: () => {
        this.deps.configStore.saveSkillsConfig(input.agentId, nextConfig);
        this.deps.bindingStore.rebuild(input.agentId, this.buildRows(input.agentId, nextConfig, revision));
      },
    });
    return { status: "changed", agentId: input.agentId, policy: input.policy, configRevision: revision, updatedAt: nextConfig.updatedAt as string };
  }

  // ── 查询 / 投影维护 ──────────────────────────────────────────

  getSkillsConfig(agentId: string): AgentSkillConfig {
    this.validateAgentId(agentId);
    return this.deps.configStore.getSkillsConfig(agentId);
  }

  /**
   * 组合 skills.json + Catalog.listByAgent：
   * - pinnedRefs = directSkillRefs + 已解析 Bundle 项（精确 SkillRef）；
   * - selectionOverrides = overrides；
   * - Bundle 项缺失（未在 Catalog）→ 诊断（skill_unknown_skillref，不静默回退）。
   */
  listAgentSkills(agentId: string, environment: ReadinessEnvironment, catalog: SkillCatalog = this.deps.catalog): AgentSkillsView {
    this.validateAgentId(agentId);
    const config = this.deps.configStore.getSkillsConfig(agentId);
    const { resolved, missing } = resolveAllBundleItems({
      bundles: this.deps.bundles,
      catalog: this.deps.catalog,
      config,
    });
    const pinnedRefs = [...config.directSkillRefs, ...resolved.map((item) => item.skillRef)];
    const output = catalog.listByAgent({
      agentId,
      pinnedRefs,
      selectionOverrides: config.overrides,
      environment,
    });
    const diagnostics = [...output.diagnostics];
    for (const key of missing) {
      diagnostics.push({
        skillId: key.startsWith("bundle:") ? key : key.split("@")[0] ?? key,
        code: "skill_unknown_skillref",
        message: `Agent 绑定引用无法解析到 Catalog（${key}），已排除且不静默回退`,
      });
    }
    return { ...output, diagnostics, bindings: config };
  }

  /** 从 skills.json（唯一事实来源）重建查询投影。 */
  rebuildBindingIndex(agentId: string): number {
    this.validateAgentId(agentId);
    const config = this.deps.configStore.getSkillsConfig(agentId);
    const { resolved } = resolveAllBundleItems({ bundles: this.deps.bundles, catalog: this.deps.catalog, config });
    const revision = this.nextRevision(agentId);
    this.deps.bindingStore.rebuild(agentId, this.buildRows(agentId, config, revision, resolved));
    return revision;
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  private buildRows(
    agentId: string,
    config: AgentSkillConfig,
    revision: number,
    resolvedItems?: readonly ResolvedBundleItem[],
  ): AgentSkillBindingWriteInput[] {
    const resolved =
      resolvedItems ??
      resolveAllBundleItems({ bundles: this.deps.bundles, catalog: this.deps.catalog, config }).resolved;
    return buildBindingRows({
      agentId,
      config,
      bundleItems: resolved,
      configRevision: revision,
      updatedAt: config.updatedAt ?? this.now().toISOString(),
    });
  }

  private nextRevision(agentId: string): number {
    return this.deps.bindingStore.maxRevision(agentId) + 1;
  }

  private assertSelectionTarget(agentId: string, config: AgentSkillConfig, skillRefKeyOf: string): void {
    if (config.directSkillRefs.some((existing) => skillRefKey(existing) === skillRefKeyOf)) {
      return;
    }
    if (config.overrides[skillRefKeyOf] !== undefined) {
      return;
    }
    const existsInCatalog = this.deps.catalog
      .list({})
      .some((candidate) => skillRefKey(candidate.skillRef) === skillRefKeyOf);
    if (!existsInCatalog) {
      throw new SkillError("skill_unknown_skillref", `目标 SkillRef 不在 Agent 绑定或 Catalog 中：${skillRefKeyOf}`);
    }
  }

  private commitStrict<T>(params: {
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
    readonly write: () => T;
  }): T {
    const operationId = `skill-binding-${params.agentId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace: TraceContext = { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
    const scope: EventScope = { ownerAgentId: params.agentId, ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}) };
    // 审计失败补偿：快照必须在写入前捕获（写入后捕获会拍到新内容）
    const fileSnapshot = previousFileSnapshot(this.deps.configStore.filePathFor(params.agentId));

    try {
      const result = runStrictAuditLifecycle(
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
          rollback: () => this.restoreConfigFile(params.agentId, fileSnapshot),
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
          const result = params.write();
          return result;
        },
      );
      this.deps.operations?.finishOperation(operationId, "completed");
      if (params.activity !== undefined) {
        this.emitActivity(params.activity.eventName, params.agentId, params.sessionId, params.activity.attributes, operationId);
      }
      return result;
    } catch (error) {
      this.deps.operations?.finishOperation(operationId, "failed", { errorCode: extractReasonCode(error) });
      if (params.activityOnFailure !== undefined) {
        this.emitActivity(params.activityOnFailure.eventName, params.agentId, params.sessionId, params.activityOnFailure.attributes, operationId);
      }
      throw error;
    }
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
      actor: { kind: "system", id: "skill-agent-bindings" },
      executor: EXECUTOR,
      scope,
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }

  private restoreConfigFile(agentId: string, snapshot: { readonly content: string | null }): void {
    const file = this.deps.configStore.filePathFor(agentId);
    if (snapshot.content === null) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 补偿失败不掩盖原错误
      }
      return;
    }
    fs.writeFileSync(file, snapshot.content, "utf8");
  }

  private validateAgentId(agentId: string): void {
    if (typeof agentId !== "string" || agentId.length < 1 || agentId.length > 128) {
      throw new SkillError("skill_agent_unauthorized", "Agent ID 不合法");
    }
  }


}

function previousFileSnapshot(file: string): { readonly content: string | null } {
  try {
    return { content: fs.readFileSync(file, "utf8") };
  } catch {
    return { content: null };
  }
}

function removeOverride(overrides: Readonly<Record<string, PersistedSelection>>, key: string): Record<string, PersistedSelection> {
  const next: Record<string, PersistedSelection> = {};
  for (const [existingKey, value] of Object.entries(overrides)) {
    if (existingKey !== key) {
      next[existingKey] = value;
    }
  }
  return next;
}

function extractReasonCode(error: unknown): string {
  if (error instanceof SkillError) {
    return error.code;
  }
  return "skill_operation_failed";
}
