import { createHash } from "node:crypto";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import {
  SUBAGENT_PLATFORM_FIXED_DENIALS,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  SUBAGENT_RUN_LIMITS_MAXIMUM,
  TOOL_SIDE_EFFECT_CLASSES,
  SubagentCapabilityRequestV1Schema,
  SubagentRunLimitsV1Schema,
  defaultSubagentCapabilityRequest,
  type SubagentCapabilityMode,
  type SubagentCapabilityRequestV1,
  type SubagentCapabilitySummary,
  type SubagentDefaultModel,
  type SubagentModelSource,
  type SubagentNetworkMode,
  type SubagentRunLimitsV1,
  type SubagentWorkspaceAccessMode,
  type ToolSideEffectClass,
} from "../../contracts/subagents.js";
import {
  SkillReadinessSchema,
  SkillRefSchema,
  SkillSelectionModeSchema,
  SkillSourceKindSchema,
  skillRefKey,
  type SkillReadiness,
  type SkillRef,
  type SkillSelectionMode,
  type SkillSourceKind,
} from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：DelegationPolicy（plans/phase-14.md §10.2 / §12 / §15.2）
//
// 纯函数委派策略，不依赖具体注入：
// - 模型解析优先级（user_default → parent_request → parent_inherited）；
// - CapabilityCeiling 归一化与稳定哈希（stable JSON + sha256）；
// - EffectiveSnapshot = 父有效能力 ∩ Thread ceiling - 平台固定禁用；
// - Tool side-effect 分类表与 read Run 拒绝规则；
// - Plugin/Skill 精确快照结构与校验函数；
// - Run limits 归一化（默认值合并 + 平台最大上限校验）。
//
// 本文件是 T3 独占文件（src/runtime/subagents/），不得被 T2 stores 修改。
// ═══════════════════════════════════════════════════════════════

// ── 稳定序列化与哈希（capability_ceiling_json / context_packet_hash）──

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      output[key] = canonicalize(record[key]);
    }
    return output;
  }
  return value;
}

/** 稳定 JSON 序列化：递归键排序、无空白——同一语义对象恒得同一字符串 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 hex（用于 ceilingHash / packetHash 等稳定指纹） */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── 模型解析（§10.2）────────────────────────────────────────────

export interface ParentModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export function parentModelEquals(a: ParentModelRef, b: ParentModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export type SubagentModelResolution =
  | {
      readonly status: "resolved";
      readonly providerId: string;
      readonly modelId: string;
      readonly source: SubagentModelSource;
      readonly resolvedAt: string;
    }
  | {
      readonly status: "error";
      readonly code: "subagent_model_override_denied" | "subagent_model_required" | "subagent_model_unavailable";
      readonly message: string;
    };

export interface ModelResolutionInput {
  /** PreferencesStore.subagents.defaultModel（未配置为 null） */
  readonly userDefault: SubagentDefaultModel;
  /** spawn_subagent 的 model 参数（主 Agent 显式选择） */
  readonly parentRequest?: ParentModelRef;
  /** 父 Turn 实际模型（继承来源；父 Turn 不存在时为 null） */
  readonly parentInherited: ParentModelRef | null;
  /** 模型可用性判定（生产接线为 ModelService.resolveModel 的 try/catch 适配） */
  readonly resolveModel: (providerId: string, modelId: string) => boolean;
  /** 时钟注入（测试用），默认 Date.now */
  readonly now?: () => number;
}

/**
 * 模型解析优先级（§10.2）：
 * 1. 用户默认存在时优先；主 Agent 传不同模型 → subagent_model_override_denied；
 *    传相同模型允许但来源标记为 user_default；
 * 2. 用户默认为空时采用主 Agent 显式选择（parent_request）；
 * 3. 均未指定时继承父 Turn 实际模型（parent_inherited）；
 * 4. 全部为空 → subagent_model_required；
 * 5. resolveModel 失败 → subagent_model_unavailable，不 fallback。
 */
export function resolveSubagentModel(input: ModelResolutionInput): SubagentModelResolution {
  const { userDefault, parentRequest, parentInherited } = input;
  const resolvedAt = new Date((input.now?.() ?? Date.now())).toISOString();

  if (userDefault !== null) {
    if (parentRequest !== undefined && !parentModelEquals(parentRequest, userDefault)) {
      return {
        status: "error",
        code: "subagent_model_override_denied",
        message: "用户已设置 Subagent 默认模型，主 Agent 传入不同模型被拒绝，不能静默覆盖",
      };
    }
    return resolveChecked(userDefault, "user_default");
  }

  if (parentRequest !== undefined) {
    return resolveChecked(parentRequest, "parent_request");
  }

  if (parentInherited !== null) {
    return resolveChecked(parentInherited, "parent_inherited");
  }

  return {
    status: "error",
    code: "subagent_model_required",
    message: "未配置 Subagent 默认模型、主 Agent 未显式指定模型且无法继承父模型，必须提供模型",
  };

  function resolveChecked(model: ParentModelRef, source: SubagentModelSource): SubagentModelResolution {
    if (!input.resolveModel(model.providerId, model.modelId)) {
      return {
        status: "error",
        code: "subagent_model_unavailable",
        message: `模型 ${model.providerId}/${model.modelId} 不可用（未配置凭据或不存在），不自动回退`,
      };
    }
    return {
      status: "resolved",
      providerId: model.providerId,
      modelId: model.modelId,
      source,
      resolvedAt,
    };
  }
}

// ── Tool side-effect 分类（§12.4 / §18.3）──────────────────────

/**
 * 已知工具副作用分类表：核心工具、父级控制工具、记忆与管理面工具。
 * 未知工具名 → "unknown"（read Run 拒绝；write Run 允许但不参与写 Lease 保护）。
 */
export const TOOL_SIDE_EFFECT_CLASSIFICATIONS: Readonly<Record<string, ToolSideEffectClass>> = {
  // 工作区只读
  read: "workspace-read",
  grep: "workspace-read",
  find: "workspace-read",
  ls: "workspace-read",
  // 工作区写入
  write: "workspace-write",
  edit: "workspace-write",
  bash: "workspace-write",
  // 父 Agent 控制工具（Subagent 永不注册；分类供审计与 read Run 拒绝）
  spawn_subagent: "administrative",
  get_subagent_status: "administrative",
  inspect_subagent: "administrative",
  steer_subagent: "administrative",
  wait_subagent: "administrative",
  cancel_subagent: "administrative",
  close_subagent: "administrative",
  // 记忆（平台固定禁用）
  search_memory: "administrative",
  memory_intent: "administrative",
  memory_agent: "administrative",
  // 管理面（平台固定禁用）
  agent_admin: "administrative",
  provider_credentials: "administrative",
  plugin_admin: "administrative",
  skill_admin: "administrative",
  observability_admin: "administrative",
  session_admin: "administrative",
  platform_config: "administrative",
  host_admin: "administrative",
  install_skill: "administrative",
  manage_skills: "administrative",
  // Subagent 内部控制工具（§13.3：不属于 CapabilityCeiling，分类仅作完整性说明）
  report_subagent_progress: "none",
  request_parent_input: "none",
  report_subagent_result: "none",
};

/** read Run 拒绝的副作用类别（§12.4 / §18.3：unknown 不进入 read Run） */
export const WORKSPACE_READ_REJECTED_SIDE_EFFECT_CLASSES: readonly ToolSideEffectClass[] = [
  "unknown",
  "workspace-write",
  "administrative",
];

/** 工具名 → sideEffectClass；未知 → "unknown" */
export function classifyToolSideEffect(toolId: string): ToolSideEffectClass {
  return TOOL_SIDE_EFFECT_CLASSIFICATIONS[toolId] ?? "unknown";
}

/** read 工作区模式下工具是否允许（拒绝 unknown/workspace-write/administrative） */
export function isToolAllowedInReadRun(toolId: string): boolean {
  return !WORKSPACE_READ_REJECTED_SIDE_EFFECT_CLASSES.includes(classifyToolSideEffect(toolId));
}

// ── CapabilityCeiling（§12.1 / §12.2）───────────────────────────

/** 归一化后的 Thread CapabilityCeiling（inherit 模式的 ids 恒为空数组） */
export interface NormalizedCapabilityCeiling {
  readonly tools: { readonly mode: SubagentCapabilityMode; readonly ids: readonly string[] };
  readonly plugins: {
    readonly mode: SubagentCapabilityMode;
    readonly pluginIds: readonly string[];
    readonly contributionIds: readonly string[];
  };
  readonly skills: { readonly mode: SubagentCapabilityMode; readonly refs: readonly SkillRef[] };
  readonly workspaceAccess: SubagentWorkspaceAccessMode;
  readonly network: SubagentNetworkMode;
}

export function normalizeCapabilityRequest(request: SubagentCapabilityRequestV1): NormalizedCapabilityCeiling {
  return {
    tools: { mode: request.tools.mode, ids: request.tools.ids ? [...request.tools.ids] : [] },
    plugins: {
      mode: request.plugins.mode,
      pluginIds: request.plugins.pluginIds ? [...request.plugins.pluginIds] : [],
      contributionIds: request.plugins.contributionIds ? [...request.plugins.contributionIds] : [],
    },
    skills: { mode: request.skills.mode, refs: request.skills.refs ? [...request.skills.refs] : [] },
    workspaceAccess: request.workspaceAccess,
    network: request.network,
  };
}

/** 默认 Ceiling（tools/plugins/skills=inherit、workspaceAccess=read、network=inherit） */
export function defaultCapabilityCeiling(): NormalizedCapabilityCeiling {
  return normalizeCapabilityRequest(defaultSubagentCapabilityRequest());
}

/** ceilingHash：稳定 JSON 序列化 + sha256（§12.1；Thread 创建时冻结） */
export function computeCapabilityCeilingHash(ceiling: NormalizedCapabilityCeiling): string {
  return sha256Hex(stableSerialize(ceiling));
}

/** spawn 工具参数的 TypeBox 校验（跨进程输入强制校验） */
export type CapabilityRequestValidationResult =
  | { readonly ok: true; readonly request: SubagentCapabilityRequestV1 }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseCapabilityRequest(value: unknown): CapabilityRequestValidationResult {
  if (Value.Check(SubagentCapabilityRequestV1Schema, value)) {
    return { ok: true, request: value };
  }
  return { ok: false, problems: collectTypeBoxProblems(SubagentCapabilityRequestV1Schema, value) };
}

// ── Plugin / Skill 精确快照（§12.5 / §12.6）────────────────────

/**
 * 父 Agent 侧插件贡献条目（T4 从 Plugin 子系统组装）：
 * 只允许父 Agent 已绑定、平台已启用、授权有效的贡献。
 */
export const ParentPluginContributionEntrySchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 128 }),
    pluginVersion: Type.String({ minLength: 1, maxLength: 128 }),
    runtimeInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    contributionId: Type.String({ minLength: 1, maxLength: 128 }),
    grantRevision: Type.Integer({ minimum: 1 }),
    sideEffectClass: Type.Union(TOOL_SIDE_EFFECT_CLASSES.map((item) => Type.Literal(item)) as never),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface ParentPluginContributionEntry {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly runtimeInstanceId: string;
  readonly contributionId: string;
  readonly grantRevision: number;
  readonly sideEffectClass: ToolSideEffectClass;
}

/** 冻结的 Plugin 快照条目（§12.5 逐字：pluginId/version/runtimeInstanceId/contributionId/grantRevision/sideEffectClass） */
export const SubagentPluginSnapshotEntrySchema = ParentPluginContributionEntrySchema;
export type SubagentPluginSnapshotEntry = ParentPluginContributionEntry;

/** 父 Agent 侧 Skill 条目：当前绑定且 ready 的 Skill 子集（T4 组装） */
export interface ParentSkillEntry {
  readonly ref: SkillRef;
  /** 快照级 contentHash（§12.6），必须与 ref.contentHash 一致 */
  readonly contentHash: string;
  readonly selectionMode: SkillSelectionMode;
  readonly readiness: SkillReadiness;
  readonly sourceKind: SkillSourceKind;
}

export const SubagentSkillSnapshotEntrySchema = Type.Object(
  {
    ref: SkillRefSchema,
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    selectionMode: SkillSelectionModeSchema,
    readiness: SkillReadinessSchema,
    sourceKind: SkillSourceKindSchema,
  },
  { additionalProperties: false },
);
export type SubagentSkillSnapshotEntry = Static<typeof SubagentSkillSnapshotEntrySchema>;

/** 校验函数：输入来自调用方（跨进程/子系统），必须过 TypeBox */
export function validatePluginSnapshotEntry(value: unknown): value is SubagentPluginSnapshotEntry {
  return Value.Check(SubagentPluginSnapshotEntrySchema, value);
}

export function validateSkillSnapshotEntry(value: unknown): value is SubagentSkillSnapshotEntry {
  return Value.Check(SubagentSkillSnapshotEntrySchema, value);
}

/** 快照 contentHash 必须与 SkillRef.contentHash 一致（精确快照完整性） */
export function skillSnapshotContentHashMatches(entry: Pick<SubagentSkillSnapshotEntry, "ref" | "contentHash">): boolean {
  return entry.contentHash === entry.ref.contentHash;
}

// ── EffectiveSnapshot（§12.1）──────────────────────────────────

export interface EffectiveSnapshotInput {
  /** 父 Agent 当前有效工具集（Run 启动时读取，参数传入） */
  readonly parentToolIds: readonly string[];
  /** 父 Agent 当前有效插件贡献（Run 启动时读取） */
  readonly parentPluginContributions: readonly ParentPluginContributionEntry[];
  /** 父 Agent 当前绑定且 ready 的 Skill（Run 启动时读取） */
  readonly parentSkillEntries: readonly ParentSkillEntry[];
  /** Thread 创建时冻结的 CapabilityCeiling */
  readonly ceiling: NormalizedCapabilityCeiling;
  /** 平台固定禁用（缺省 §12.3 逐字清单） */
  readonly fixedDenials?: readonly string[];
}

/** 某次 Run 实际冻结的有效能力快照（§12.1；当前 Run 不可漂移） */
export interface EffectiveSnapshot {
  readonly ceilingHash: string;
  readonly workspaceAccess: SubagentWorkspaceAccessMode;
  readonly network: SubagentNetworkMode;
  readonly toolIds: readonly string[];
  readonly pluginContributions: readonly SubagentPluginSnapshotEntry[];
  readonly skills: readonly SubagentSkillSnapshotEntry[];
  readonly fixedDenials: readonly string[];
}

/**
 * EffectiveSnapshot = 父有效能力 ∩ Thread ceiling - 平台固定禁用。
 * - inherit：继承父当前集合；allowlist：与请求列表求交集（无列表 = 空，fail-closed）；
 * - 固定禁用恒剔除；
 * - read Run 拒绝 unknown/workspace-write/administrative 工具与插件贡献；
 * - Skill 只保留 readiness=ready 且 contentHash 一致的条目。
 */
export function computeEffectiveSnapshot(input: EffectiveSnapshotInput): EffectiveSnapshot {
  const fixedDenials = input.fixedDenials ?? SUBAGENT_PLATFORM_FIXED_DENIALS;
  const ceiling = input.ceiling;
  const readOnly = ceiling.workspaceAccess === "read";

  const toolIds = dedupe(
    selectByMode(input.parentToolIds, ceiling.tools.mode, ceiling.tools.ids)
      .filter((id) => !fixedDenials.includes(id))
      .filter((id) => !readOnly || isToolAllowedInReadRun(id)),
  );

  const pluginContributions = dedupeBy(
    selectPluginContributions(input.parentPluginContributions, ceiling, fixedDenials),
    (entry) => `${entry.pluginId}/${entry.contributionId}`,
  ).filter((entry) => !readOnly || !WORKSPACE_READ_REJECTED_SIDE_EFFECT_CLASSES.includes(entry.sideEffectClass));

  const skills = dedupeBy(input.parentSkillEntries, (entry) => skillRefKey(entry.ref))
    .filter((entry) => entry.readiness === "ready")
    .filter((entry) => skillSnapshotContentHashMatches(entry))
    .filter((entry) => {
      if (ceiling.skills.mode === "inherit") {
        return true;
      }
      return ceiling.skills.refs.some((ref) => skillRefKey(ref) === skillRefKey(entry.ref));
    });

  return {
    ceilingHash: computeCapabilityCeilingHash(ceiling),
    workspaceAccess: ceiling.workspaceAccess,
    network: ceiling.network,
    toolIds,
    pluginContributions,
    skills,
    fixedDenials: [...fixedDenials],
  };
}

/** 转为 §12.2 契约形状 SubagentCapabilitySummary（spawn 返回 / Thread 行摘要） */
export function summarizeEffectiveSnapshot(snapshot: EffectiveSnapshot): SubagentCapabilitySummary {
  return {
    ceilingHash: snapshot.ceilingHash,
    workspaceAccess: snapshot.workspaceAccess,
    toolIds: [...snapshot.toolIds],
    pluginContributionIds: snapshot.pluginContributions.map((entry) => entry.contributionId),
    skillRefs: snapshot.skills.map((entry) => entry.ref),
    network: snapshot.network,
    fixedDenials: [...snapshot.fixedDenials],
  };
}

function selectByMode(parent: readonly string[], mode: SubagentCapabilityMode, ids: readonly string[]): readonly string[] {
  if (mode === "inherit") {
    return parent;
  }
  return parent.filter((id) => ids.includes(id));
}

function selectPluginContributions(
  parent: readonly ParentPluginContributionEntry[],
  ceiling: NormalizedCapabilityCeiling,
  fixedDenials: readonly string[],
): readonly ParentPluginContributionEntry[] {
  // allowlist：与请求列表求交集（空列表 = 空 allowlist，fail-closed——
  // 与 tools/skills 的空 allowlist 语义一致，无列表不视为"全部"）
  const allowlisted =
    ceiling.plugins.mode === "inherit"
      ? parent
      : parent.filter(
          (entry) =>
            ceiling.plugins.pluginIds.includes(entry.pluginId) &&
            ceiling.plugins.contributionIds.includes(entry.contributionId),
        );
  return allowlisted.filter(
    (entry) =>
      !fixedDenials.includes(entry.contributionId) &&
      !fixedDenials.includes(entry.pluginId) &&
      // 纵深防御：贡献名若与平台管理/控制工具重名（如 plugin_admin、spawn_subagent），
      // 一律按 administrative 拒绝，插件不能借名字绕过固定禁用。
      classifyToolSideEffect(entry.contributionId) !== "administrative",
  );
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      output.push(item);
    }
  }
  return output;
}

// ── Run limits 归一化（§15.2）──────────────────────────────────

export type RunLimitsNormalizationResult =
  | { readonly ok: true; readonly limits: SubagentRunLimitsV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * 主 Agent 请求的 limits（Partial）与平台默认合并；请求值不能超过
 * SUBAGENT_RUN_LIMITS_MAXIMUM（§15.2：可以更小，不能更大）。
 */
export function normalizeSubagentRunLimits(requested: Partial<SubagentRunLimitsV1> | undefined): RunLimitsNormalizationResult {
  const merged: Record<string, unknown> = { ...SUBAGENT_RUN_LIMITS_DEFAULTS };
  if (requested !== undefined) {
    for (const key of Object.keys(requested) as readonly (keyof SubagentRunLimitsV1)[]) {
      merged[key] = requested[key];
    }
  }

  if (!Value.Check(SubagentRunLimitsV1Schema, merged)) {
    const problems = collectTypeBoxProblems(SubagentRunLimitsV1Schema, merged);
    return { ok: false, reason: `Run limits 非法：${problems.join("；")}` };
  }

  if (requested !== undefined) {
    for (const key of Object.keys(requested) as readonly (keyof SubagentRunLimitsV1)[]) {
      const value = requested[key];
      const maximum = SUBAGENT_RUN_LIMITS_MAXIMUM[key];
      if (value !== undefined && value > maximum) {
        return {
          ok: false,
          reason: `${key} 请求值 ${value} 超过平台最大值 ${maximum}`,
        };
      }
    }
  }

  return { ok: true, limits: merged as SubagentRunLimitsV1 };
}

// ── TypeBox 校验辅助 ───────────────────────────────────────────

/** 收集 TypeBox 校验错误（最多 3 条，跨进程输入拒绝时诊断用） */
export function collectTypeBoxProblems(schema: unknown, value: unknown, limit = 3): string[] {
  const problems: string[] = [];
  for (const error of Value.Errors(schema as Parameters<typeof Value.Errors>[0], value)) {
    problems.push(`${"path" in error && typeof error.path === "string" ? error.path : "$"}: ${error.message}`);
    if (problems.length >= limit) {
      break;
    }
  }
  return problems;
}

