import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 13 Skill 系统共享契约（plans/phase-13.md §五 / §7 / §8.4）
//
// - 稳定引用：SkillRef / BundleRef——任何绑定、审计、快照和回滚都不得只保存
//   名称，必须保存精确 SkillRef（来源、版本、内容哈希）；
// - 四类正交状态：validity / trust / readiness / selection；
// - 兼容等级：native / pi-compatible / openclaw / hermes / metadata-only /
//   unsupported（兼容失败给出迁移建议，不生成表面成功的空壳）；
// - 声明不等于权限：Skill 的 requires/allowed-tools 只用于依赖提示、风险展示
//   和 readiness 判定，不能创建任何 Grant；
// - 本文件是 T1 冻结的契约，T2-T9 按此实现；跨进程输入必须过 TypeBox 校验。
// ═══════════════════════════════════════════════════════════════

// ── 稳定引用 ──────────────────────────────────────────────────

export const SKILL_SOURCE_KINDS = ["builtin", "managed", "plugin", "workspace", "external"] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export const SkillSourceKindSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("managed"),
  Type.Literal("plugin"),
  Type.Literal("workspace"),
  Type.Literal("external"),
]);

/** 精确 SkillRef：来源 + 版本 + 内容哈希。名称只用于展示和搜索。 */
export const SkillRefSchema = Type.Object(
  {
    skillId: Type.String({ minLength: 1, maxLength: 128 }),
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    sourceKind: SkillSourceKindSchema,
    version: Type.String({ minLength: 1, maxLength: 64 }),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type SkillRef = Static<typeof SkillRefSchema>;

/** Bundle 引用：版本化 SkillRef 集合（变更必须新建版本，不能原地覆盖）。 */
export const BundleRefSchema = Type.Object(
  {
    bundleId: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type BundleRef = Static<typeof BundleRefSchema>;

/** 稳定字符串键：事件/日志/表主键统一用此键（不信任名称）。 */
export function skillRefKey(skillRef: Pick<SkillRef, "skillId" | "sourceId" | "version">): string {
  return `${skillRef.skillId}@${skillRef.sourceId}@${skillRef.version}`;
}

// ── 四类正交状态 ──────────────────────────────────────────────

/** validity：格式、frontmatter、路径和内容完整性 */
export const SkillValiditySchema = Type.Union([Type.Literal("valid"), Type.Literal("invalid")]);
export type SkillValidity = Static<typeof SkillValiditySchema>;

/** trust：来源和用户确认状态 */
export const SkillTrustSchema = Type.Union([Type.Literal("trusted"), Type.Literal("untrusted")]);
export type SkillTrust = Static<typeof SkillTrustSchema>;

/**
 * readiness：当前 OS、bins、env、配置、插件和依赖是否满足。
 * 安全隔离使用 blocked（保留原绑定与审计证据），不能伪装成 Agent 主动停用。
 */
export const SkillReadinessSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("degraded"),
  Type.Literal("blocked"),
  Type.Literal("incompatible"),
]);
export type SkillReadiness = Static<typeof SkillReadinessSchema>;

/** selection：当前 Agent 是否允许模型自动发现或显式使用 */
export const SkillSelectionModeSchema = Type.Union([
  Type.Literal("implicit"),
  Type.Literal("explicit-only"),
  Type.Literal("disabled"),
  Type.Literal("shadowed"),
]);
export type SkillSelectionMode = Static<typeof SkillSelectionModeSchema>;

export const SkillStatusSchema = Type.Object(
  {
    validity: SkillValiditySchema,
    trust: SkillTrustSchema,
    readiness: SkillReadinessSchema,
    selection: SkillSelectionModeSchema,
    /** blocked 等状态的稳定原因码（安全/依赖/来源失效） */
    blockedReason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type SkillStatus = Static<typeof SkillStatusSchema>;

// ── 兼容等级 ──────────────────────────────────────────────────

export const SKILL_COMPATIBILITY_LEVELS = [
  "native",
  "pi-compatible",
  "openclaw",
  "hermes",
  "metadata-only",
  "unsupported",
] as const;
export type SkillCompatibilityLevel = (typeof SKILL_COMPATIBILITY_LEVELS)[number];

export const SkillCompatibilityLevelSchema = Type.Union([
  Type.Literal("native"),
  Type.Literal("pi-compatible"),
  Type.Literal("openclaw"),
  Type.Literal("hermes"),
  Type.Literal("metadata-only"),
  Type.Literal("unsupported"),
]);

/** 兼容性报告：必须显示缺失字段、降级行为与是否需要手工迁移。 */
export const SkillCompatibilityReportSchema = Type.Object(
  {
    level: SkillCompatibilityLevelSchema,
    /** 缺失/不兼容字段清单 */
    missing: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 }),
    /** 降级行为说明 */
    degradation: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /** 是否需要手工迁移 */
    requiresManualMigration: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SkillCompatibilityReport = Static<typeof SkillCompatibilityReportSchema>;

// ── OpenColorful 扩展（metadata.opencolorful）─────────────────

const SKILL_OS = ["win32", "darwin", "linux"] as const;

export const SkillRequiresSchema = Type.Object(
  {
    plugins: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    bins: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    env: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    os: Type.Optional(Type.Array(Type.Union([Type.Literal("win32"), Type.Literal("darwin"), Type.Literal("linux")]), { maxItems: 3 })),
  },
  { additionalProperties: false },
);
export type SkillRequires = Static<typeof SkillRequiresSchema>;

export const SkillRecommendsSchema = Type.Object(
  {
    skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
    plugins: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type SkillRecommends = Static<typeof SkillRecommendsSchema>;

/** 平台扩展只能放在 metadata.opencolorful；requires 只生成 readiness/诊断，不创建 Grant。 */
export const OpenColorfulSkillMetadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    requires: Type.Optional(SkillRequiresSchema),
    recommends: Type.Optional(SkillRecommendsSchema),
    risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  },
  { additionalProperties: false },
);
export type OpenColorfulSkillMetadata = Static<typeof OpenColorfulSkillMetadataSchema>;

// ── Normalized Skill Manifest ─────────────────────────────────

/**
 * 标准化后的 Skill Manifest（SKILL.md frontmatter + 平台扩展）。
 * - 兼容 Agent Skills / PI / OpenClaw / Hermes 常用字段；
 * - 普通未知字段保留在 rawFrontmatter 并给出诊断；
 * - 未知高风险字段不得静默授权（按拒绝/标记处理，见校验器 T2）。
 */
export const NormalizedSkillManifestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: 2048 }),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    compatibility: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** 仅解析为依赖提示，不产生 plugin_grants 或 sandbox capabilities */
    allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
    /** PI/Agent Skills 通用字段：禁用模型自动调用（仅显式触发） */
    disableModelInvocation: Type.Optional(Type.Boolean()),
    /** OpenColorful 平台扩展 */
    opencolorful: Type.Optional(OpenColorfulSkillMetadataSchema),
    /** 保留原始未知字段（用于诊断/展示，不做授权） */
    rawFrontmatter: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown()),
    compatibilityLevel: SkillCompatibilityLevelSchema,
    compatibilityReport: Type.Optional(SkillCompatibilityReportSchema),
  },
  { additionalProperties: false },
);
export type NormalizedSkillManifest = Static<typeof NormalizedSkillManifestSchema>;

/** SKILL.md 解析结果：frontmatter 原文 + 正文（正文不进入系统提示） */
export interface SkillDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

// ── 来源与安装 ────────────────────────────────────────────────

export const SKILL_SOURCE_ADAPTER_KINDS = ["local", "archive", "git", "http", "openclaw", "hermes"] as const;
export type SkillSourceAdapterKind = (typeof SKILL_SOURCE_ADAPTER_KINDS)[number];

export const SkillProvenanceSchema = Type.Object(
  {
    sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
    fetchedAt: Type.String({ minLength: 1, maxLength: 64 }),
    originalUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type SkillProvenance = Static<typeof SkillProvenanceSchema>;

/** 来源发现的候选（不安装；provenance 只作展示） */
export const SkillSourceCandidateSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    sourceKind: SkillSourceKindSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    provenance: Type.Optional(SkillProvenanceSchema),
  },
  { additionalProperties: false },
);
export type SkillSourceCandidate = Static<typeof SkillSourceCandidateSchema>;

/** 暂存后的完整包（只接受完整 package：目录/ZIP/.skill/Git 子目录/已登记 SessionFile） */
export const SkillStagedPackageSchema = Type.Object(
  {
    packageRoot: Type.String({ minLength: 1, maxLength: 1024 }),
    manifestPath: Type.String({ minLength: 1, maxLength: 1024 }),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    fileCount: Type.Integer({ minimum: 0 }),
    provenance: SkillProvenanceSchema,
  },
  { additionalProperties: false },
);
export type SkillStagedPackage = Static<typeof SkillStagedPackageSchema>;

/** 来源适配器能力声明（Phase 13 §8.3：是否支持搜索/安装/更新/离线） */
export const SkillSourceCapabilitiesSchema = Type.Object(
  {
    search: Type.Boolean(),
    install: Type.Boolean(),
    update: Type.Boolean(),
    offline: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SkillSourceCapabilities = Static<typeof SkillSourceCapabilitiesSchema>;

// ── 稳定错误 reasonCode（跨进程诊断，不暴露内部细节）────────────

export const SKILL_ERROR_CODES = [
  // 安装/来源
  "skill_source_not_found",
  "skill_source_unsupported",
  "skill_package_invalid",
  "skill_path_escape",
  "skill_zip_slip",
  "skill_symlink_escape",
  "skill_duplicate_path",
  "skill_too_large",
  "skill_file_type_denied",
  "skill_binary_denied",
  "skill_manifest_invalid",
  "skill_not_a_complete_package",
  // 解析/状态
  "skill_unknown_skillref",
  "skill_shadowed",
  "skill_not_in_snapshot",
  "skill_readiness_blocked",
  "skill_dependency_cycle",
  "skill_dependency_too_deep",
  "skill_dependency_too_many",
  // 内容读取
  "skill_content_hash_mismatch",
  "skill_content_missing",
  "skill_content_too_large",
  "skill_content_read_denied",
  "skill_load_handle_expired",
  "skill_load_handle_consumed",
  // 激活/审批
  "skill_confirmation_expired",
  "skill_confirmation_reused",
  "skill_confirmation_target_mismatch",
  "skill_activation_expired",
  "skill_activation_reused",
  "skill_activation_denied",
  // 操作
  "skill_operation_failed",
  "skill_rollback_failed",
  "skill_already_installed",
  "skill_version_conflict",
  "skill_agent_unauthorized",
] as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

/** 稳定错误：跨进程/日志/审计统一使用 code + reasonCode（不暴露内部细节） */
export const SkillErrorSchema = Type.Object(
  {
    code: Type.Union(SKILL_ERROR_CODES.map((c) => Type.Literal(c)) as never),
    message: Type.String({ minLength: 1, maxLength: 512 }),
    detail: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);
export type SkillError = Static<typeof SkillErrorSchema>;

// ── 注入预算（T5 冻结，§六 6.2 / §十 10.2）─────────────────────

export const SKILL_BUDGETS = {
  /** Snapshot 可见 Skill 上限 */
  maxSkillsPerSnapshot: 32,
  /** 全部元数据（系统提示注入）合计上限（字符） */
  maxMetadataChars: 4000,
  /** ContentService 单文件正文上限（字节） */
  maxSingleFileBytes: 256 * 1024,
  /** 每 turn 支持文件读取总量上限（字节） */
  maxSupportBytesPerTurn: 512 * 1024,
  /** 依赖解析最大深度 */
  maxDependencyDepth: 4,
  /** 单次依赖检查最多 Skill 数 */
  maxDependencyCheckSkills: 32,
  /** 支持文件读取超时（ms） */
  contentReadTimeoutMs: 10_000,
} as const;

/** loadHandle：单 turn 受控读取入口（绑定 turnId+sessionId+skillRef+contentHash） */
export const SkillLoadHandleSchema = Type.Object(
  {
    handleId: Type.String({ minLength: 1, maxLength: 128 }),
    turnId: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    skillRef: SkillRefSchema,
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    issuedAt: Type.String({ minLength: 1, maxLength: 64 }),
    expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
    /** 单次有效：turn 结束或首次读取后过期 */
    consumed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SkillLoadHandle = Static<typeof SkillLoadHandleSchema>;
