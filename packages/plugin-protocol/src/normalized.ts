import { type Static, Type } from "typebox";
import { ContributionsSchema } from "./contribution.js";
import { PermissionRequestSchema } from "./permission.js";
import { ArtifactVerificationSchema, PluginSourceRefSchema } from "./compatibility.js";
import { ManifestCompatibilitySchema, ManifestRuntimeSchema, PLUGIN_ID_PATTERN, SEMVER_PATTERN, TRUST_LEVELS } from "./manifest.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 规范化插件模型（plans/phase-12.md §六）
//
// 外部生态 Manifest 先转换为 NormalizedPluginManifest，原始文件作为
// provenance 保存。PluginManager 只处理规范化后的模型，不包含任何
// ClawHub/GitHub/npm/Hermes 专属逻辑。
// ═══════════════════════════════════════════════════════════════

/** 规范化来源信息：来源引用 + 校验结果 + 原始 Manifest（provenance） */
export const NormalizedSourceSchema = Type.Object(
  {
    sourceRef: PluginSourceRefSchema,
    verification: ArtifactVerificationSchema,
    /** 原始 Manifest/元数据原文（provenance，审计不可随 cache 删除） */
    provenance: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type NormalizedSource = Static<typeof NormalizedSourceSchema>;

export const NormalizedPluginManifestSchema = Type.Object(
  {
    id: Type.String({ pattern: PLUGIN_ID_PATTERN }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ pattern: SEMVER_PATTERN }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    author: Type.Optional(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 128 }),
          email: Type.Optional(Type.String({ minLength: 3, maxLength: 256 })),
          url: Type.Optional(Type.String({ minLength: 3, maxLength: 512 })),
        },
        { additionalProperties: false },
      ),
    ),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    compatibility: ManifestCompatibilitySchema,
    trust: Type.Union([Type.Literal("restricted"), Type.Literal("full-access")]),
    runtime: ManifestRuntimeSchema,
    permissions: Type.Array(PermissionRequestSchema, { maxItems: 256 }),
    contributions: ContributionsSchema,
    /** 配置 Schema（非敏感）；Secret 只声明不存值 */
    config: Type.Optional(Type.Unknown()),
    source: NormalizedSourceSchema,
    /** 规范化/转换时间 */
    normalizedAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type NormalizedPluginManifest = Static<typeof NormalizedPluginManifestSchema>;

/** 插件安装记录（plugin_installations 事实来源的领域视图） */
export const PluginInstallationSchema = Type.Object(
  {
    pluginId: Type.String({ pattern: PLUGIN_ID_PATTERN }),
    version: Type.String({ pattern: SEMVER_PATTERN }),
    /** active version 标记：只有 active 版本被加载 */
    active: Type.Boolean(),
    status: Type.String({ minLength: 1, maxLength: 32 }),
    source: NormalizedSourceSchema,
    installedAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type PluginInstallation = Static<typeof PluginInstallationSchema>;
