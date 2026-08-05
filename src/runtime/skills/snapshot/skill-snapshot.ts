import crypto from "node:crypto";

import { Type, type Static } from "typebox";
import Value from "typebox/value";

import {
  SKILL_BUDGETS,
  SkillReadinessSchema,
  SkillRefSchema,
  SkillSelectionModeSchema,
  SkillStatusSchema,
  skillRefKey,
  type SkillReadiness,
  type SkillRef,
  type SkillSelectionMode,
  type SkillStatus,
} from "../../../contracts/skill-protocol.js";
import type { SkillActivationGrantRecord } from "../../../storage/skill-activation-grant-store.js";
import type { ResolveOutput, ResolutionDiagnostic, ResolvedSkill } from "../resolver.js";
import { SkillError } from "../errors.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 Turn Skill Snapshot（plans/phase-13.md §6.1 / §10.2 / §18.4）
//
// - beginTurn 冻结的不可变快照：只读、deepFreeze、绝不返回 undefined；
// - 冻结内容：snapshotId/agentId/sessionId/turnId、可见 SkillRef[]（含
//   来源/版本/哈希）+ selection + validity/trust/readiness、依赖检查结果、
//   shadowed/disabled/gated 四态结果、诊断、turn 开始前未消费未过期的
//   激活授权摘要、元数据注入文本（预算截断）、快照哈希；
// - 支持文件首读冻结：snapshot.supportFiles 是冻结视图，SkillSnapshotService
//   freezeSupportFile 以不可变更新（返回新快照对象）追加条目，原对象不变；
// - 会话内安装不修改已开始的 Snapshot（overlay 由 ContentService 在读取时
//   叠加当前 turn 的 activation grant，不改变 snapshotId）；
// - 构造失败抛显式 SkillError（Phase 12 T15 教训：不得返回 undefined）；
// - shouldRebuild：绑定/版本/来源信任/插件实例/贡献集变化 → 下一 turn 重建
//   （供 T6 在 turn 边界调用）。
// ═══════════════════════════════════════════════════════════════

export const SKILL_SNAPSHOT_PREFIX = "skill-snap-";
export const SKILL_MAIN_FILE = "SKILL.md";

// ── Snapshot 条目 / 结构 ───────────────────────────────────────

export interface SkillSnapshotEntry {
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly skillId: string;
  readonly displayName: string;
  readonly description: string | undefined;
  /** 解析后的选择模式（visible 集内为 implicit/explicit-only） */
  readonly selection: SkillSelectionMode;
  /** validity/trust/readiness/blockedReason（解析结果） */
  readonly status: SkillStatus;
  readonly readiness: SkillReadiness;
  /** 是否来自 Agent 固定引用（pinned 优先于 implicit 截断） */
  readonly pinned: boolean;
  /** 依赖检查结果（requires 缺失项 → 不满足；只诊断不授权） */
  readonly dependency: { readonly satisfied: boolean; readonly missing: readonly string[] };
  /** manifest.disableModelInvocation 透传（PI Skill 映射用） */
  readonly disableModelInvocation: boolean;
  /** 受控读取根目录（供 PI loader/read 工具解析 filePath，不在 T1 契约内） */
  readonly rootPath: string;
}

/** 激活授权摘要（turn 开始前未消费未过期；overlay 判定的基础） */
export interface SkillSnapshotGrant {
  readonly grantId: string;
  readonly skillRefKey: string;
  readonly contentHash: string;
  readonly issuedTurnId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

/** 支持文件首读冻结条目（相对路径 + 单文件哈希 + 大小） */
export interface SkillSupportFileEntry {
  readonly skillRefKey: string;
  /** 相对路径（前向斜杠），如 references/guide.md */
  readonly relativePath: string;
  /** hashFileEntries 单文件确定性哈希（`sha256-<hex>`） */
  readonly fileHash: string;
  readonly sizeBytes: number;
  readonly frozenAt: string;
}

export interface SkillSnapshot {
  readonly snapshotId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAt: string;
  /** 可见集（≤ maxSkillsPerSnapshot，pinned 优先；ContentService 唯一授权来源） */
  readonly entries: readonly SkillSnapshotEntry[];
  /** entries 的精确 SkillRef 视图（同一顺序） */
  readonly visibleRefs: readonly SkillRef[];
  readonly shadowed: readonly SkillSnapshotEntry[];
  readonly disabled: readonly SkillSnapshotEntry[];
  readonly gated: readonly SkillSnapshotEntry[];
  readonly diagnostics: readonly ResolutionDiagnostic[];
  /** turn 开始前已经存在的激活授权摘要（未消费未过期） */
  readonly activationGrants: readonly SkillSnapshotGrant[];
  /** 支持文件首读冻结 manifest（不可变视图；freezeSupportFile 产生新快照） */
  readonly supportFiles: readonly SkillSupportFileEntry[];
  /** 元数据注入文本（系统提示用；不含正文） */
  readonly metadata: { readonly text: string; readonly truncated: boolean; readonly charCount: number };
  /** 可见条目超过 maxSkillsPerSnapshot 被截断 */
  readonly truncatedSkills: boolean;
  /** 结构指纹哈希（refs/status/四态/诊断/授权摘要；支持文件变化不改变） */
  readonly snapshotHash: string;
}

// ── TypeBox 校验（跨边界数据必须过 Schema）──────────────────────

export const SkillSnapshotEntrySchema = Type.Object(
  {
    skillRef: SkillRefSchema,
    skillRefKey: Type.String({ minLength: 1, maxLength: 256 }),
    skillId: Type.String({ minLength: 1, maxLength: 128 }),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    selection: SkillSelectionModeSchema,
    status: SkillStatusSchema,
    readiness: SkillReadinessSchema,
    pinned: Type.Boolean(),
    dependency: Type.Object(
      {
        satisfied: Type.Boolean(),
        missing: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
      },
      { additionalProperties: false },
    ),
    disableModelInvocation: Type.Boolean(),
    rootPath: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);

export const SkillSnapshotGrantSchema = Type.Object(
  {
    grantId: Type.String({ minLength: 1, maxLength: 128 }),
    skillRefKey: Type.String({ minLength: 1, maxLength: 256 }),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    issuedTurnId: Type.String({ minLength: 1, maxLength: 128 }),
    expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
    consumedAt: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
  },
  { additionalProperties: false },
);

export const SkillSupportFileEntrySchema = Type.Object(
  {
    skillRefKey: Type.String({ minLength: 1, maxLength: 256 }),
    relativePath: Type.String({ minLength: 1, maxLength: 1024 }),
    fileHash: Type.String({ minLength: 1, maxLength: 64 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    frozenAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const SkillSnapshotSchema = Type.Object(
  {
    snapshotId: Type.String({ minLength: 1, maxLength: 128 }),
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    turnId: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
    entries: Type.Array(SkillSnapshotEntrySchema, { maxItems: 32 }),
    visibleRefs: Type.Array(SkillRefSchema, { maxItems: 32 }),
    shadowed: Type.Array(SkillSnapshotEntrySchema, { maxItems: 64 }),
    disabled: Type.Array(SkillSnapshotEntrySchema, { maxItems: 64 }),
    gated: Type.Array(SkillSnapshotEntrySchema, { maxItems: 64 }),
    diagnostics: Type.Array(
      Type.Object(
        {
          skillId: Type.String({ minLength: 1, maxLength: 128 }),
          skillRef: Type.Optional(SkillRefSchema),
          code: Type.String({ minLength: 1, maxLength: 128 }),
          message: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    activationGrants: Type.Array(SkillSnapshotGrantSchema, { maxItems: 128 }),
    supportFiles: Type.Array(SkillSupportFileEntrySchema, { maxItems: 256 }),
    metadata: Type.Object(
      {
        text: Type.String(),
        truncated: Type.Boolean(),
        charCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    truncatedSkills: Type.Boolean(),
    snapshotHash: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type SkillSnapshotSchema = Static<typeof SkillSnapshotSchema>;

// ── Snapshot 预算（缺省取冻结契约；测试可注入更小值）──────────────

export interface SkillSnapshotBudgets {
  readonly maxSkillsPerSnapshot: number;
  readonly maxMetadataChars: number;
}

const DEFAULT_SNAPSHOT_BUDGETS: SkillSnapshotBudgets = {
  maxSkillsPerSnapshot: SKILL_BUDGETS.maxSkillsPerSnapshot,
  maxMetadataChars: SKILL_BUDGETS.maxMetadataChars,
};

export interface CreateSkillSnapshotInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolveOutput: ResolveOutput;
  /** turn 开始前已经存在的激活授权（未消费未过期；快照冻结摘要） */
  readonly activationGrants?: readonly SkillActivationGrantRecord[];
}

export interface SkillSnapshotServiceDeps {
  readonly now?: () => Date;
  readonly budgets?: Partial<SkillSnapshotBudgets>;
}

export class SkillSnapshotService {
  private readonly now: () => Date;
  private readonly budgets: SkillSnapshotBudgets;

  constructor(deps: SkillSnapshotServiceDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.budgets = { ...DEFAULT_SNAPSHOT_BUDGETS, ...(deps.budgets ?? {}) };
  }

  /**
   * 创建不可变 Turn Skill Snapshot。构造失败抛显式 SkillError，
   * 绝不返回 undefined（fail-closed）。
   */
  createSkillSnapshot(input: CreateSkillSnapshotInput): SkillSnapshot {
    this.validateIdentity(input.agentId, "Agent ID");
    this.validateIdentity(input.sessionId, "Session ID");
    this.validateIdentity(input.turnId, "Turn ID");
    const output = input.resolveOutput;
    if (typeof output !== "object" || output === null || !Array.isArray(output.visible)) {
      throw new SkillError("skill_operation_failed", "Snapshot 构造失败：ResolveOutput 不合法（缺少 visible 可见集）");
    }

    const createdAt = this.now().toISOString();
    const entryOf = toSnapshotEntry;
    const ordered = [...output.visible].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
    const entries = ordered.slice(0, this.budgets.maxSkillsPerSnapshot).map(entryOf);
    const truncatedSkills = output.visible.length > entries.length;
    const metadata = buildMetadataText(entries, this.budgets.maxMetadataChars);
    const activationGrants = (input.activationGrants ?? []).map(toSnapshotGrant);
    const snapshot: SkillSnapshot = {
      snapshotId: `${SKILL_SNAPSHOT_PREFIX}${crypto.randomUUID()}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt,
      entries,
      visibleRefs: entries.map((entry) => entry.skillRef),
      shadowed: output.shadowed.map(entryOf),
      disabled: output.disabled.map(entryOf),
      gated: output.gated.map(entryOf),
      diagnostics: [...output.diagnostics],
      activationGrants,
      supportFiles: [],
      metadata,
      truncatedSkills,
      snapshotHash: computeSnapshotHash({
        entries,
        shadowed: output.shadowed.map(entryOf),
        disabled: output.disabled.map(entryOf),
        gated: output.gated.map(entryOf),
        diagnostics: output.diagnostics,
        activationGrants,
        metadataText: metadata.text,
      }),
    };
    const frozen = deepFreeze(snapshot);
    this.assertValid(frozen);
    return frozen;
  }

  /** 校验 Snapshot 协议合法性（每次使用前复核；fail-closed 不静默信任）。 */
  validateSnapshot(snapshot: unknown): { ok: boolean; reason?: string } {
    if (!Value.Check(SkillSnapshotSchema, snapshot)) {
      return { ok: false, reason: "Skill Snapshot 不符合协议 schema" };
    }
    return { ok: true };
  }

  /** 可见 SkillRef 列表（ContentService / T6 判定读取授权的唯一来源）。 */
  snapshotVisibleRefs(snapshot: SkillSnapshot): readonly SkillRef[] {
    const validation = this.validateSnapshot(snapshot);
    if (!validation.ok) {
      throw new SkillError("skill_operation_failed", `Snapshot 校验失败：${validation.reason ?? "unknown"}`);
    }
    return snapshot.visibleRefs;
  }

  /**
   * 支持文件首读冻结：把（skillRefKey, relativePath, fileHash）加入 manifest。
   * 不可变更新：返回**新**冻结 Snapshot（snapshotId 不变）；已存在同键条目时
   * 幂等返回原对象。哈希不一致的覆写由 ContentService 在调用前拒绝。
   */
  freezeSupportFile(snapshot: SkillSnapshot, entry: SkillSupportFileEntry): SkillSnapshot {
    const validation = this.validateSnapshot(snapshot);
    if (!validation.ok) {
      throw new SkillError("skill_operation_failed", `Snapshot 校验失败：${validation.reason ?? "unknown"}`);
    }
    const existing = snapshot.supportFiles.some(
      (file) => file.skillRefKey === entry.skillRefKey && file.relativePath === entry.relativePath,
    );
    if (existing) {
      return snapshot;
    }
    if (!Value.Check(SkillSupportFileEntrySchema, entry)) {
      throw new SkillError("skill_operation_failed", "支持文件冻结条目不符合协议 schema");
    }
    const next: SkillSnapshot = { ...snapshot, supportFiles: [...snapshot.supportFiles, entry] };
    const frozen = deepFreeze(next);
    this.assertValid(frozen);
    return frozen;
  }

  /**
   * Snapshot 重建判定（T6 在 turn 边界调用）：绑定（pinned）、版本（skillRef）、
   * 来源信任（trust）、插件实例/贡献集（readiness、可见/门控集合）或激活授权
   * 摘要变化 → true。支持文件首读冻结（supportFiles）不触发重建。
   */
  shouldRebuild(previous: SkillSnapshot, current: SkillSnapshot): boolean {
    return fingerprint(previous) !== fingerprint(current);
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  private assertValid(snapshot: SkillSnapshot): void {
    const validation = this.validateSnapshot(snapshot);
    if (!validation.ok) {
      throw new SkillError("skill_operation_failed", `Snapshot 构造失败：${validation.reason ?? "unknown"}`);
    }
  }

  private validateIdentity(value: string, what: string): void {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new SkillError("skill_operation_failed", `Snapshot 构造失败：${what} 不合法`);
    }
  }
}

// ── 内部辅助 ───────────────────────────────────────────────────

function toSnapshotEntry(resolved: ResolvedSkill): SkillSnapshotEntry {
  return {
    skillRef: resolved.skillRef,
    skillRefKey: skillRefKey(resolved.skillRef),
    skillId: resolved.skillId,
    displayName: resolved.displayName,
    description: resolved.description,
    selection: resolved.status.selection,
    status: resolved.status,
    readiness: resolved.status.readiness,
    pinned: resolved.pinned,
    dependency: {
      satisfied: resolved.readiness.missing.length === 0,
      missing: resolved.readiness.missing,
    },
    disableModelInvocation: resolved.manifest?.disableModelInvocation ?? false,
    rootPath: resolved.rootPath,
  };
}

function toSnapshotGrant(grant: SkillActivationGrantRecord): SkillSnapshotGrant {
  return {
    grantId: grant.grantId,
    skillRefKey: grant.skillRefKey,
    contentHash: grant.contentHash,
    issuedTurnId: grant.issuedTurnId,
    expiresAt: grant.expiresAt,
    consumedAt: grant.consumedAt,
  };
}

/**
 * 元数据注入文本（§10.3：只有名称、描述、来源和 readiness 摘要，无正文）。
 * 预算截断：pinned 优先；单条放不下时截断 description；连名称都放不下则停止。
 * 保证 text.length ≤ maxChars（不可超出预算）。
 */
function buildMetadataText(entries: readonly SkillSnapshotEntry[], maxChars: number): { text: string; truncated: boolean; charCount: number } {
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of entries) {
    const tag = ` [${entry.skillRef.sourceKind}|${entry.status.readiness}]`;
    const nameLine = `- ${entry.displayName}${tag}`;
    if (used + nameLine.length > maxChars) {
      truncated = true;
      break;
    }
    const description = entry.description ?? "";
    const remaining = maxChars - used - nameLine.length - 2; // ": " 前缀
    let line: string;
    if (description.length > 0 && remaining > 0) {
      const descPart = description.slice(0, Math.max(0, remaining));
      if (descPart.length < description.length) {
        truncated = true;
      }
      line = `- ${entry.displayName}: ${descPart}${tag}`;
      if (line.length > maxChars - used) {
        line = nameLine;
        truncated = true;
      }
    } else {
      line = nameLine;
      if (description.length > 0) {
        truncated = true;
      }
    }
    lines.push(line);
    used += line.length;
  }
  const text = lines.join("\n");
  return { text, truncated, charCount: text.length };
}

/** 结构指纹：四态结果 + 诊断 + 激活授权摘要（不含正文与支持文件）。 */
function fingerprint(snapshot: SkillSnapshot): string {
  const entryFingerprint = (entry: SkillSnapshotEntry): string =>
    [entry.skillRefKey, entry.skillRef.contentHash, entry.selection, entry.status.trust, entry.status.readiness, entry.pinned ? "1" : "0"].join("|");
  const diagFingerprint = (diag: ResolutionDiagnostic): string => `${diag.skillId}|${diag.code}`;
  const grantFingerprint = (grant: SkillSnapshotGrant): string =>
    `${grant.grantId}|${grant.skillRefKey}|${grant.contentHash}|${grant.expiresAt}|${grant.consumedAt ?? ""}`;
  return JSON.stringify({
    entries: snapshot.entries.map(entryFingerprint),
    shadowed: snapshot.shadowed.map(entryFingerprint),
    disabled: snapshot.disabled.map(entryFingerprint),
    gated: snapshot.gated.map(entryFingerprint),
    diagnostics: snapshot.diagnostics.map(diagFingerprint),
    activationGrants: snapshot.activationGrants.map(grantFingerprint),
  });
}

/** 确定性结构哈希：`sha256-<hex57>`（与 Skill contentHash 同格式约束）。 */
function computeSnapshotHash(parts: {
  readonly entries: readonly SkillSnapshotEntry[];
  readonly shadowed: readonly SkillSnapshotEntry[];
  readonly disabled: readonly SkillSnapshotEntry[];
  readonly gated: readonly SkillSnapshotEntry[];
  readonly diagnostics: readonly ResolutionDiagnostic[];
  readonly activationGrants: readonly SkillSnapshotGrant[];
  readonly metadataText: string;
}): string {
  const canonical = JSON.stringify({
    entries: parts.entries.map(entryFingerprint),
    shadowed: parts.shadowed.map(entryFingerprint),
    disabled: parts.disabled.map(entryFingerprint),
    gated: parts.gated.map(entryFingerprint),
    diagnostics: parts.diagnostics.map((diag) => `${diag.skillId}|${diag.code}`),
    activationGrants: parts.activationGrants.map((grant) => `${grant.grantId}|${grant.skillRefKey}|${grant.contentHash}|${grant.expiresAt}|${grant.consumedAt ?? ""}`),
    metadataText: parts.metadataText,
  });
  return `sha256-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 57)}`;
}

function entryFingerprint(entry: SkillSnapshotEntry): string {
  return [entry.skillRefKey, entry.skillRef.contentHash, entry.selection, entry.status.trust, entry.status.readiness, entry.pinned ? "1" : "0"].join("|");
}

/** 深度冻结（嵌套对象/数组全部不可变；与 plugins/grants 同模式）。 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
