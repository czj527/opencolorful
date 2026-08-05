import { skillRefKey, type NormalizedSkillManifest, type SkillCompatibilityReport, type SkillProvenance, type SkillReadiness, type SkillRef, type SkillSelectionMode, type SkillSourceKind, type SkillStatus, type SkillValidity } from "../../../contracts/skill-protocol.js";
import { SkillError, assertSkillRef } from "../errors.js";
import { slugifySkillId } from "../manifest.js";
import { diagnoseReadiness, type ReadinessEnvironment } from "../readiness.js";
import { resolveSkillCandidates, type ResolveOutput } from "../resolver.js";
import type { SkillPackageErrorInfo } from "../validator.js";
import type { SkillSourceCandidate, SkillSourceInspection } from "../sources/skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill Catalog 事实模型（plans/phase-13.md §9.1）
//
// - 按 skillRefKey（skillId@sourceId@version）保存候选/已登记 Skill；
// - 同名候选全部保留，低优先级项在 Resolver 中标记 shadowed（此处不丢弃）；
// - resolveBySkillRef 精确匹配（含 contentHash），失败 fail-closed 抛错；
// - selectExactRef：用户/Agent 显式选择精确 SkillRef（平台默认选择模式 →
//   explicit-only；Agent 级绑定/选择由 T4 提供 selectionOverrides）；
// - listByAgent：给 T4 用，把 Agent 固定引用 + 覆盖选择注入 Resolver。
// ═══════════════════════════════════════════════════════════════

export interface RegisterCandidateInput {
  readonly skillId: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly version: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly manifest: NormalizedSkillManifest | null;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly validity: SkillValidity;
  readonly validityErrors: readonly string[];
  readonly provenance?: SkillProvenance;
  /** 来源信任决策（trust policy 评估结果） */
  readonly trusted: boolean;
  /** 平台默认选择模式（缺省：valid→implicit / invalid→disabled） */
  readonly selection?: SkillSelectionMode;
  /** 登记时的环境快照（用于初始 readiness 诊断） */
  readonly environment: ReadinessEnvironment;
}

export interface RegisteredSkill {
  readonly skillRef: SkillRef;
  readonly skillId: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly version: string;
  readonly contentHash: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly rootPath: string;
  readonly manifest: NormalizedSkillManifest | null;
  readonly status: SkillStatus;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly provenance: SkillProvenance | undefined;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly validityErrors: readonly string[];
}

interface InternalRecord {
  readonly skillRef: SkillRef;
  readonly skillId: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly version: string;
  readonly contentHash: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly rootPath: string;
  readonly manifest: NormalizedSkillManifest | null;
  readonly validity: SkillValidity;
  readonly trust: "trusted" | "untrusted";
  selection: SkillSelectionMode;
  readonly readiness: SkillReadiness;
  readonly blockedReason: string | undefined;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly provenance: SkillProvenance | undefined;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly validityErrors: readonly string[];
}

export interface SkillCatalogListOptions {
  readonly sourceKind?: SkillSourceKind;
  readonly validity?: SkillValidity;
  readonly readiness?: SkillReadiness;
  readonly selection?: SkillSelectionMode;
  /** 名称/描述模糊匹配 */
  readonly query?: string;
}

export interface AgentSkillVisibilityInput {
  readonly agentId: string;
  /** Agent 固定引用（T4：Agent skills.json 的直接 SkillRef） */
  readonly pinnedRefs: readonly SkillRef[];
  /** Agent 级选择覆盖（skillRefKey → selection；T4 提供） */
  readonly selectionOverrides?: Readonly<Record<string, SkillSelectionMode>>;
  readonly environment: ReadinessEnvironment;
}

export class SkillCatalog {
  private readonly registry = new Map<string, InternalRecord>();

  /** 登记/刷新候选（同一 refKey 已存在则替换；返回登记快照）。 */
  registerCandidate(input: RegisterCandidateInput): RegisteredSkill {
    if (input.contentHash.length === 0) {
      throw new SkillError("skill_package_invalid", "内容哈希不可用，无法登记候选");
    }
    const skillRef: SkillRef = {
      skillId: input.skillId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      version: input.version,
      contentHash: input.contentHash,
    };
    const validity = input.validity;
    const diagnosis = diagnoseReadiness(input.manifest, input.environment);
    const selection =
      input.selection ?? (validity === "valid" ? "implicit" : "disabled");
    const record: InternalRecord = {
      skillRef,
      skillId: input.skillId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      version: input.version,
      contentHash: input.contentHash,
      displayName: input.displayName,
      description: input.manifest?.description,
      rootPath: input.rootPath,
      manifest: input.manifest,
      validity,
      trust: input.trusted ? "trusted" : "untrusted",
      selection,
      readiness: diagnosis.readiness,
      blockedReason: diagnosis.blockedReason,
      compatibility: input.compatibility,
      provenance: input.provenance,
      sizeBytes: input.sizeBytes,
      fileCount: input.fileCount,
      validityErrors: input.validityErrors,
    };
    this.registry.set(skillRefKey(skillRef), record);
    return toRegistered(record);
  }

  /** 精确解析（skillId+sourceId+version+contentHash 全匹配）；缺失抛错（fail-closed）。 */
  resolveBySkillRef(skillRef: SkillRef): RegisteredSkill {
    const ref = assertSkillRef(skillRef);
    const record = this.registry.get(skillRefKey(ref));
    if (record === undefined) {
      throw new SkillError("skill_unknown_skillref", `Catalog 中不存在该 SkillRef：${skillRefKey(ref)}`);
    }
    if (record.contentHash !== ref.contentHash) {
      throw new SkillError("skill_content_hash_mismatch", "SkillRef 内容哈希与 Catalog 登记不一致");
    }
    return toRegistered(record);
  }

  /** Resolver 内部精确查找（不抛错，返回 undefined 由 Resolver 生成诊断）。 */
  findCandidateByRef(skillRef: SkillRef): RegisteredSkill | undefined {
    const record = this.registry.get(skillRefKey(skillRef));
    if (record === undefined || record.contentHash !== skillRef.contentHash) {
      return undefined;
    }
    return toRegistered(record);
  }

  list(options: SkillCatalogListOptions = {}): readonly RegisteredSkill[] {
    const needle = (options.query ?? "").trim().toLowerCase();
    const records = [...this.registry.values()].filter((record) => {
      if (options.sourceKind !== undefined && record.sourceKind !== options.sourceKind) {
        return false;
      }
      if (options.validity !== undefined && record.validity !== options.validity) {
        return false;
      }
      if (options.readiness !== undefined && record.readiness !== options.readiness) {
        return false;
      }
      if (options.selection !== undefined && record.selection !== options.selection) {
        return false;
      }
      if (needle !== "" && !record.displayName.toLowerCase().includes(needle) && !record.skillId.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
    records.sort((a, b) => {
      if (a.skillId !== b.skillId) {
        return a.skillId < b.skillId ? -1 : 1;
      }
      if (a.sourceKind !== b.sourceKind) {
        return a.sourceKind < b.sourceKind ? -1 : 1;
      }
      return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
    });
    return records.map(toRegistered);
  }

  /** 某 Agent 可见集（T4 使用）：Agent 固定引用 + 覆盖选择 + 环境快照 → Resolver。 */
  listByAgent(input: AgentSkillVisibilityInput): ResolveOutput {
    return resolveSkillCandidates({
      candidates: [...this.registry.values()].map(toRegistered),
      pinnedRefs: input.pinnedRefs,
      ...(input.selectionOverrides !== undefined ? { selectionOverrides: input.selectionOverrides } : {}),
      environment: input.environment,
    });
  }

  /** 用户/Agent 显式选择精确 SkillRef（平台默认选择模式 → explicit-only）。 */
  selectExactRef(skillRef: SkillRef): RegisteredSkill {
    const ref = assertSkillRef(skillRef);
    const record = this.registry.get(skillRefKey(ref));
    if (record === undefined) {
      throw new SkillError("skill_unknown_skillref", `Catalog 中不存在该 SkillRef：${skillRefKey(ref)}`);
    }
    if (record.contentHash !== ref.contentHash) {
      throw new SkillError("skill_content_hash_mismatch", "SkillRef 内容哈希与 Catalog 登记不一致");
    }
    record.selection = "explicit-only";
    return toRegistered(record);
  }

  /**
   * 从适配器 discover + inspect 结果登记候选（skillId 由 manifest.name 规范化）。
   * 失败路径 fail-closed：哈希不可用时抛错，调用方列入 failed 报告。
   */
  ingestCandidate(input: {
    readonly candidate: SkillSourceCandidate;
    readonly inspection: SkillSourceInspection;
    readonly trusted: boolean;
    readonly environment: ReadinessEnvironment;
  }): RegisteredSkill {
    const { candidate, inspection } = input;
    const valid = inspection.errors.length === 0;
    const skillId = slugifySkillId(inspection.manifest?.name ?? candidate.displayName);
    return this.registerCandidate({
      skillId,
      sourceId: candidate.sourceId,
      sourceKind: candidate.sourceKind,
      version: candidate.version ?? "0.0.0",
      displayName: candidate.displayName,
      rootPath: inspection.packageRoot,
      contentHash: inspection.contentHash,
      sizeBytes: inspection.sizeBytes,
      fileCount: inspection.fileCount,
      manifest: inspection.manifest,
      compatibility: inspection.compatibility,
      validity: valid ? "valid" : "invalid",
      validityErrors: valid ? [] : inspection.errors.map((error) => error.message),
      ...(candidate.provenance !== undefined ? { provenance: candidate.provenance } : {}),
      trusted: input.trusted,
      environment: input.environment,
    });
  }
}

// ── 登记快照 ───────────────────────────────────────────────────

function toRegistered(record: InternalRecord): RegisteredSkill {
  const status: SkillStatus = {
    validity: record.validity,
    trust: record.trust,
    readiness: record.readiness,
    selection: record.selection,
    ...(record.blockedReason !== undefined ? { blockedReason: record.blockedReason } : {}),
  };
  return {
    skillRef: record.skillRef,
    skillId: record.skillId,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    version: record.version,
    contentHash: record.contentHash,
    displayName: record.displayName,
    description: record.description,
    rootPath: record.rootPath,
    manifest: record.manifest,
    status,
    compatibility: record.compatibility,
    provenance: record.provenance,
    sizeBytes: record.sizeBytes,
    fileCount: record.fileCount,
    validityErrors: record.validityErrors,
  };
}
