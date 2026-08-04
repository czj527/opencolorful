import { type Static, Type } from "typebox";
import { ContributionsSchema } from "./contribution.js";
import { PermissionRequestSchema } from "./permission.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Manifest v1（plans/phase-12.md §7.1）
//
// - id 全局稳定，不可因更新改变；
// - version 使用 SemVer；
// - pluginApi 明确宿主协议版本；
// - 未知字段默认拒绝（additionalProperties: false），不静默忽略高风险字段；
// - Manifest 不能声明"已授权"或伪造平台安装状态；
// - Secret 字段只声明名称、用途和校验规则，不在 Manifest 保存值。
// ═══════════════════════════════════════════════════════════════

export const PLUGIN_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";
export const SEMVER_PATTERN = "^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$";

export const TRUST_LEVELS = ["restricted", "full-access"] as const;
export type PluginTrust = (typeof TRUST_LEVELS)[number];

export const RUNTIME_KINDS = ["bundle", "mcp", "node-process", "python-process"] as const;
export type PluginRuntimeKind = (typeof RUNTIME_KINDS)[number];

/** 插件 API 版本：宿主协议版本，拒绝不兼容 major（本阶段固定 1） */
export const PLUGIN_API_VERSION = 1 as const;

export const AuthorSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    email: Type.Optional(Type.String({ minLength: 3, maxLength: 256 })),
    url: Type.Optional(Type.String({ minLength: 3, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type PluginAuthor = Static<typeof AuthorSchema>;

export const ManifestCompatibilitySchema = Type.Object(
  {
    opencolorful: Type.String({ minLength: 1, maxLength: 64 }), // SemVer range，如 ">=1.0.0"
    pluginApi: Type.Literal(PLUGIN_API_VERSION),
  },
  { additionalProperties: false },
);
export type ManifestCompatibility = Static<typeof ManifestCompatibilitySchema>;

export const ManifestRuntimeSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("bundle"), Type.Literal("mcp"), Type.Literal("node-process"), Type.Literal("python-process")]),
    /** 代码插件的入口文件（相对插件根）；bundle/mcp 可省略 */
    entry: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type ManifestRuntime = Static<typeof ManifestRuntimeSchema>;

export const ManifestDevSchema = Type.Object(
  {
    /** 开发态源码目录（相对插件根），dev install 时复制 */
    sourceDir: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** 插件声明的语言/运行时版本提示（仅诊断展示，不自动安装） */
    engines: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 128 })),
    ),
  },
  { additionalProperties: false },
);
export type ManifestDev = Static<typeof ManifestDevSchema>;

export const ManifestV1Schema = Type.Object(
  {
    manifestVersion: Type.Literal(1),
    id: Type.String({ pattern: PLUGIN_ID_PATTERN }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ pattern: SEMVER_PATTERN }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    author: Type.Optional(AuthorSchema),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    compatibility: ManifestCompatibilitySchema,
    trust: Type.Union([Type.Literal("restricted"), Type.Literal("full-access")]),
    runtime: ManifestRuntimeSchema,
    /** 权限请求：能力族枚举，实际授权由平台 grant 决定 */
    permissions: Type.Array(PermissionRequestSchema, { maxItems: 256 }),
    /** 扩展点声明（§八 10 类；未知种类拒绝） */
    contributions: ContributionsSchema,
    /** 配置 Schema（JSON Schema/TypeBox 可验证子集）；Secret 只声明不存值 */
    config: Type.Optional(Type.Unknown()),
    dev: Type.Optional(ManifestDevSchema),
  },
  { additionalProperties: false },
);
export type ManifestV1 = Static<typeof ManifestV1Schema>;

export const PLUGIN_STATUSES = [
  "discovered", "staged", "installed", "enabled", "degraded", "disabled", "failed", "removed",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];
