import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 12 来源与兼容性（plans/phase-12.md §12）
//
// Source Adapter 与 Runtime Adapter 分离：市场只负责发现和获取 Artifact，
// 不能直接启用或执行插件。兼容等级 L1-L6，不承诺 100% 兼容。
// ═══════════════════════════════════════════════════════════════

export const PLUGIN_SOURCE_TYPES = [
  "local",
  "zip",
  "git",
  "npm",
  "openclaw",
  "hermes",
  "mcp",
] as const;
export type PluginSourceType = (typeof PLUGIN_SOURCE_TYPES)[number];

/** 来源引用：Source Adapter 的统一解析目标 */
export const PluginSourceRefSchema = Type.Object(
  {
    sourceType: Type.Union(PLUGIN_SOURCE_TYPES.map((type) => Type.Literal(type))),
    /** 来源地址/路径/包名（不保存 Secret） */
    ref: Type.String({ minLength: 1, maxLength: 2048 }),
    /** 固定版本/commit/tag；来源缓存不得测试 latest */
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    lock: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type PluginSourceRef = Static<typeof PluginSourceRefSchema>;

/** Artifact 校验结果：hash 与 provenance */
export const ArtifactVerificationSchema = Type.Object(
  {
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    /** 原始来源元数据（Manifest 原文、市场描述等），保存为 provenance */
    provenance: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ArtifactVerification = Static<typeof ArtifactVerificationSchema>;

export const COMPATIBILITY_LEVELS = ["L1", "L2", "L3", "L4", "L5", "L6"] as const;
export type CompatibilityLevel = (typeof COMPATIBILITY_LEVELS)[number];

export const COMPATIBILITY_ITEM_STATUSES = ["supported", "unsupported", "degraded", "blocked"] as const;
export type CompatibilityItemStatus = (typeof COMPATIBILITY_ITEM_STATUSES)[number];

/**
 * 兼容性报告：安装前必须展示当前支持等级、不支持的 contributions、
 * 需要转换的字段、所需 Runtime/依赖、权限请求、是否 full-access 和来源锁定。
 */
export const CompatibilityReportSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    /** 最高达到的兼容等级 */
    level: Type.Union(COMPATIBILITY_LEVELS.map((level) => Type.Literal(level))),
    supported: Type.Boolean(),
    missingCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 }),
    /** 每项 contribution 的兼容结论 */
    contributions: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          kind: Type.String({ minLength: 1, maxLength: 64 }),
          status: Type.Union(COMPATIBILITY_ITEM_STATUSES.map((status) => Type.Literal(status))),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 512 },
    ),
    blockedReasons: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 }),
    requiresFullAccess: Type.Boolean(),
    requiresRuntime: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type CompatibilityReport = Static<typeof CompatibilityReportSchema>;
