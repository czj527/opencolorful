import { skillRefKey, type NormalizedSkillManifest, type SkillCompatibilityReport, type SkillErrorCode, type SkillProvenance, type SkillRef, type SkillSelectionMode, type SkillSourceKind, type SkillStatus } from "../../contracts/skill-protocol.js";
import type { RegisteredSkill } from "./catalog/skill-catalog.js";
import { diagnoseReadiness, isReadinessPassing, type ReadinessDiagnosis, type ReadinessEnvironment } from "./readiness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill Resolver（plans/phase-13.md §8.2 / §5.2）
//
// 默认解析优先级：workspace > managed > plugin > external > builtin。
// 固定规则优先于名称优先级：
//   1. 已绑定精确 SkillRef 永远使用该版本和哈希；
//   2. 同名候选全部保留，低优先级项标记 shadowed；
//   3. Workspace 同名项不能替换已固定的 Managed/Plugin/Builtin Skill；
//   4. 删除/失效的高优先级候选不静默回退到另一个同名 Skill（fail-closed）。
// readiness 只诊断不授权（对照当前平台环境/插件清单，T7 再接入真实状态）。
// ═══════════════════════════════════════════════════════════════

/** 默认解析优先级（数值越小优先级越高）。 */
export const SKILL_SOURCE_PRECEDENCE: Record<SkillSourceKind, number> = {
  workspace: 0,
  managed: 1,
  plugin: 2,
  external: 3,
  builtin: 4,
};

export interface ResolveInput {
  /** Catalog 中全部候选（同名冲突保留，由本模块决定可见性） */
  readonly candidates: readonly RegisteredSkill[];
  /** Agent 固定引用（T4 提供：Agent skills.json 的直接 SkillRef） */
  readonly pinnedRefs: readonly SkillRef[];
  /** Agent 级选择覆盖（skillRefKey → selection；T4 提供） */
  readonly selectionOverrides?: Readonly<Record<string, SkillSelectionMode>>;
  /** 当前平台/环境快照（readiness 诊断用） */
  readonly environment: ReadinessEnvironment;
}

export interface ResolvedSkill {
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly skillId: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly rootPath: string;
  readonly manifest: NormalizedSkillManifest | null;
  /** 有效状态：selection 为解析后的选择模式（可能为 shadowed/disabled） */
  readonly status: SkillStatus;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly provenance: SkillProvenance | undefined;
  readonly readiness: ReadinessDiagnosis;
  /** 是否来自 Agent 固定引用 */
  readonly pinned: boolean;
}

export interface ResolutionDiagnostic {
  readonly skillId: string;
  readonly skillRef?: SkillRef;
  readonly code: SkillErrorCode;
  readonly message: string;
}

export interface ResolveOutput {
  /** 进入可见集的 Skill（readiness ready/degraded；selection implicit/explicit-only） */
  readonly visible: readonly ResolvedSkill[];
  /** 同名冲突被 shadowed 的候选（仍在 Catalog，不进入解析结果） */
  readonly shadowed: readonly ResolvedSkill[];
  /** 被持久/覆盖为 disabled 的 Skill（非错误，只是当前 Agent 不使用） */
  readonly disabled: readonly ResolvedSkill[];
  /** 因无效/incompatible/blocked 被门控的候选（fail-closed，不静默回退） */
  readonly gated: readonly ResolvedSkill[];
  /** 固定引用缺失/失效等诊断 */
  readonly diagnostics: readonly ResolutionDiagnostic[];
}

export function resolveSkillCandidates(input: ResolveInput): ResolveOutput {
  const { candidates, pinnedRefs, environment } = input;
  const overrides = input.selectionOverrides ?? {};
  const visible: ResolvedSkill[] = [];
  const shadowed: ResolvedSkill[] = [];
  const disabled: ResolvedSkill[] = [];
  const gated: ResolvedSkill[] = [];
  const diagnostics: ResolutionDiagnostic[] = [];

  const byRefKey = new Map<string, RegisteredSkill>();
  for (const candidate of candidates) {
    byRefKey.set(skillRefKey(candidate.skillRef), candidate);
  }

  // ── 1. 固定引用优先（精确 SkillRef，含 contentHash） ───────────
  const pinnedKeys = new Set<string>();
  const pinnedSkillIds = new Set<string>();
  /** 固定引用失效（缺失/无效/readiness 不满足）→ 同名候选不得静默回退 */
  const blockedSkillIds = new Set<string>();
  for (const ref of pinnedRefs) {
    const key = skillRefKey(ref);
    const candidate = byRefKey.get(key);
    if (candidate === undefined || candidate.skillRef.contentHash !== ref.contentHash) {
      blockedSkillIds.add(ref.skillId);
      diagnostics.push({
        skillId: ref.skillId,
        skillRef: ref,
        code: "skill_unknown_skillref",
        message: `已固定 SkillRef 不在 Catalog 中，未回退到同名 Skill（${key}）`,
      });
      continue;
    }
    pinnedKeys.add(key);
    const selection = effectiveSelection(overrides[key] ?? candidate.status.selection);
    const diagnosis = diagnoseReadiness(candidate.manifest, environment);
    const resolved = toResolved(candidate, diagnosis, selection, true);
    if (candidate.status.validity === "invalid") {
      blockedSkillIds.add(candidate.skillId);
      gated.push(resolved);
      diagnostics.push({
        skillId: candidate.skillId,
        skillRef: ref,
        code: "skill_manifest_invalid",
        message: "已固定 Skill 无效（manifest 校验失败），不静默回退",
      });
      continue;
    }
    if (!isReadinessPassing(diagnosis.readiness)) {
      blockedSkillIds.add(candidate.skillId);
      gated.push(resolved);
      diagnostics.push({
        skillId: candidate.skillId,
        skillRef: ref,
        code: "skill_readiness_blocked",
        message: `已固定 Skill readiness 不满足（${diagnosis.readiness}），不静默回退`,
      });
      continue;
    }
    pinnedSkillIds.add(candidate.skillId);
    if (selection === "disabled") {
      disabled.push(resolved);
      continue;
    }
    visible.push(resolved);
  }

  // ── 2. 未固定候选按 skillId 分组，优先级 + shadowed + readiness ─
  const groups = new Map<string, RegisteredSkill[]>();
  for (const candidate of candidates) {
    if (pinnedKeys.has(skillRefKey(candidate.skillRef))) {
      continue;
    }
    const list = groups.get(candidate.skillId);
    if (list === undefined) {
      groups.set(candidate.skillId, [candidate]);
    } else {
      list.push(candidate);
    }
  }

  for (const [skillId, group] of groups) {
    if (pinnedSkillIds.has(skillId)) {
      // 已固定引用存在：Workspace/其他来源同名项不能替换固定引用 → 全部 shadowed
      for (const candidate of group) {
        shadowed.push(toResolved(candidate, diagnoseReadiness(candidate.manifest, environment), "shadowed", false));
      }
      continue;
    }
    if (blockedSkillIds.has(skillId)) {
      // 已固定引用失效（缺失/无效/readiness 不满足）：不静默回退到同名候选
      for (const candidate of group) {
        gated.push(toResolved(candidate, diagnoseReadiness(candidate.manifest, environment), candidate.status.selection, false));
      }
      diagnostics.push({
        skillId,
        code: "skill_unknown_skillref",
        message: "已固定 SkillRef 失效，同名候选被门控，等待重新解析（fail-closed）",
      });
      continue;
    }
    const effective = group.map((candidate) => ({
      candidate,
      selection: effectiveSelection(overrides[skillRefKey(candidate.skillRef)] ?? candidate.status.selection),
    }));
    // T11（P0-5）：未固定 managed/plugin/external 候选对当前 Agent 不可见——
    // 安装默认只绑定当前 Agent（§11.5），未绑定来源不进入可见集；
    // builtin（平台随版本提供）与 workspace（session 工作区解析）保持全局可见。
    // 未绑定候选进 gated + 诊断（不静默丢弃，可查原因）。
    const agentVisibleKinds: ReadonlySet<SkillSourceKind> = new Set(["builtin", "workspace"]);
    const unbound: typeof effective = [];
    const pool = effective.filter((entry) => {
      if (agentVisibleKinds.has(entry.candidate.sourceKind)) {
        return true;
      }
      unbound.push(entry);
      return false;
    });
    if (unbound.length > 0) {
      for (const entry of unbound) {
        gated.push(toResolved(entry.candidate, diagnoseReadiness(entry.candidate.manifest, environment), entry.selection, false));
      }
      diagnostics.push({
        skillId,
        code: "skill_unknown_skillref",
        message: `${unbound.length} 个未绑定候选（managed/plugin/external）不进入当前 Agent 可见集（安装默认只绑定当前 Agent）`,
      });
    }
    if (pool.length === 0) {
      // 全部候选未绑定：已进 gated + 诊断，不再走 manifest 无效分支（避免重复/误报）
      continue;
    }
    const explicitOnly = pool.filter((entry) => entry.selection === "explicit-only");
    const pool2 = explicitOnly.length > 0 ? explicitOnly : pool;
    // explicit-only 排除的同名候选 → shadowed（同池中未被显式选择的项不进入可见集，也不消失）
    const excludedByExplicitOnly = explicitOnly.length > 0 ? pool.filter((entry) => entry.selection !== "explicit-only") : [];
    const valid = pool2.filter((entry) => entry.candidate.status.validity === "valid");

    if (valid.length === 0) {
      for (const entry of effective) {
        const diagnosis = diagnoseReadiness(entry.candidate.manifest, environment);
        gated.push(toResolved(entry.candidate, diagnosis, entry.selection, false));
      }
      diagnostics.push({
        skillId,
        code: "skill_manifest_invalid",
        message: "同名候选全部无效（manifest 校验失败），未进入解析结果",
      });
      continue;
    }

    const winner = pickWinner(valid);
    const winnerDiagnosis = diagnoseReadiness(winner.candidate.manifest, environment);
    const resolved = toResolved(winner.candidate, winnerDiagnosis, winner.selection, false);
    // T11（P0-5）：losers 只含可见来源池（unbound 已进 gated，不重复进 shadowed）
    const losers = [...pool2.filter((entry) => entry !== winner), ...excludedByExplicitOnly];

    if (!isReadinessPassing(winnerDiagnosis.readiness)) {
      gated.push(resolved);
      diagnostics.push({
        skillId,
        code: "skill_readiness_blocked",
        message: `Skill readiness 不满足（${winnerDiagnosis.readiness}），不静默回退到同名候选`,
      });
      for (const entry of losers) {
        shadowed.push(toResolved(entry.candidate, diagnoseReadiness(entry.candidate.manifest, environment), "shadowed", false));
      }
      continue;
    }
    if (winner.selection === "disabled") {
      disabled.push(resolved);
      for (const entry of losers) {
        shadowed.push(toResolved(entry.candidate, diagnoseReadiness(entry.candidate.manifest, environment), "shadowed", false));
      }
      continue;
    }
    visible.push(resolved);
    for (const entry of losers) {
      shadowed.push(toResolved(entry.candidate, diagnoseReadiness(entry.candidate.manifest, environment), "shadowed", false));
    }
  }

  return { visible, shadowed, disabled, gated, diagnostics };
}

// ── 内部辅助 ───────────────────────────────────────────────────

function pickWinner(valid: readonly { candidate: RegisteredSkill; selection: SkillSelectionMode }[]): { candidate: RegisteredSkill; selection: SkillSelectionMode } {
  const sorted = [...valid].sort((a, b) => {
    const pa = SKILL_SOURCE_PRECEDENCE[a.candidate.sourceKind] ?? 99;
    const pb = SKILL_SOURCE_PRECEDENCE[b.candidate.sourceKind] ?? 99;
    if (pa !== pb) {
      return pa - pb;
    }
    const versionCompare = compareVersionsDesc(a.candidate.version, b.candidate.version);
    if (versionCompare !== 0) {
      return versionCompare;
    }
    return a.candidate.sourceId < b.candidate.sourceId ? -1 : a.candidate.sourceId > b.candidate.sourceId ? 1 : 0;
  });
  return sorted[0] as { candidate: RegisteredSkill; selection: SkillSelectionMode };
}

function toResolved(
  candidate: RegisteredSkill,
  diagnosis: ReadinessDiagnosis,
  selection: SkillSelectionMode,
  pinned: boolean,
): ResolvedSkill {
  const status: SkillStatus = {
    validity: candidate.status.validity,
    trust: candidate.status.trust,
    readiness: diagnosis.readiness,
    selection,
    ...(diagnosis.blockedReason !== undefined ? { blockedReason: diagnosis.blockedReason } : {}),
  };
  return {
    skillRef: candidate.skillRef,
    skillRefKey: skillRefKey(candidate.skillRef),
    skillId: candidate.skillId,
    displayName: candidate.displayName,
    description: candidate.description,
    rootPath: candidate.rootPath,
    manifest: candidate.manifest,
    status,
    compatibility: candidate.compatibility,
    provenance: candidate.provenance,
    readiness: diagnosis,
    pinned,
  };
}

function effectiveSelection(value: SkillSelectionMode | undefined): SkillSelectionMode {
  return value ?? "implicit";
}

/** 版本号从大到小比较（分段数值比较；不可解析时按字符串倒序兜底）。 */
export function compareVersionsDesc(a: string, b: string): number {
  const aSegments = a.split(/[^0-9]+/).filter((segment) => segment !== "").map(Number);
  const bSegments = b.split(/[^0-9]+/).filter((segment) => segment !== "").map(Number);
  const length = Math.max(aSegments.length, bSegments.length);
  for (let i = 0; i < length; i += 1) {
    const av = aSegments[i] ?? 0;
    const bv = bSegments[i] ?? 0;
    if (av !== bv) {
      return av > bv ? -1 : 1;
    }
  }
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}
