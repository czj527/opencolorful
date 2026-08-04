import { type Static, Type } from "typebox";
import { PermissionRequestSchema } from "./permission.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 扩展点契约（plans/phase-12.md §八，10 类）
//
// 每个 contribution 必须单独声明权限和兼容状态；
// 插件不能自行决定是否需要用户确认，风险策略由平台目录和 Manifest 共同决定。
// ═══════════════════════════════════════════════════════════════

export const CONTRIBUTION_KINDS = [
  "tool",
  "command",
  "provider",
  "route",
  "page",
  "widget",
  "chat-surface",
  "background",
  "hook",
  "config",
  "secret",
  "context-attachment",
  "custom-activity",
  "skill-bundle",
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const TOOL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

/** 通用 contribution 基础：稳定 id + 名称 + 描述 + 所需能力 */
export const ContributionBaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    /** 该 contribution 需要的额外能力（附加在插件级权限之上） */
    requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type ContributionBase = Static<typeof ContributionBaseSchema>;

export const ToolContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 输入 Schema（JSON Schema 子集）；平台负责 Schema 校验、大小限制和脱敏 */
    inputSchema: Type.Optional(Type.Unknown()),
    outputSchema: Type.Optional(Type.Unknown()),
    riskLevel: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  },
  { additionalProperties: false },
);
export type ToolContribution = Static<typeof ToolContributionSchema>;

export const CommandContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 命令不自动绕过模型或工具权限；UI、CLI、桌面端共享描述 */
    argumentsSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type CommandContribution = Static<typeof CommandContributionSchema>;

export const ProviderContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** Provider 只通过稳定 Port 注册能力和配置 Schema */
    configSchema: Type.Optional(Type.Unknown()),
    kind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type ProviderContribution = Static<typeof ProviderContributionSchema>;

export const RouteContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 固定 namespace /api/plugins/:pluginId/<path>，不能注册根路径或覆盖 Core API */
    path: Type.String({ minLength: 1, maxLength: 256 }),
    methods: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8 }), { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type RouteContribution = Static<typeof RouteContributionSchema>;

export const SurfaceContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 静态资源入口（相对插件根），由受控 asset route 托管 */
    entry: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** 需要的 Host capability（theme/toast/clipboard/external-open 等） */
    hostCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
  },
  { additionalProperties: false },
);
export type SurfaceContribution = Static<typeof SurfaceContributionSchema>;

export const BackgroundContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 后台任务必须声明并发、重试、幂等键和资源预算 */
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3600_000 })),
  },
  { additionalProperties: false },
);
export type BackgroundContribution = Static<typeof BackgroundContributionSchema>;

export const HookContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 平台冻结的时点，不能任意 monkey patch Agent Loop */
    point: Type.String({ minLength: 1, maxLength: 128 }),
    /** before Hook 失败默认阻止其负责的变更 */
    behavior: Type.Optional(Type.Union([Type.Literal("block"), Type.Literal("observe")])),
  },
  { additionalProperties: false },
);
export type HookContribution = Static<typeof HookContributionSchema>;

export const ConfigContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 非敏感配置 Schema（TypeBox/JSON Schema 子集） */
    schema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ConfigContribution = Static<typeof ConfigContributionSchema>;

export const SecretContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** Secret 只声明名称、用途和校验规则，不在 Manifest 保存值 */
    secretName: Type.String({ minLength: 1, maxLength: 128 }),
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type SecretContribution = Static<typeof SecretContributionSchema>;

export const ContextAttachmentContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 结构化附件类型 Schema；平台验证 Schema、大小、来源和当前 Session 权限 */
    schema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ContextAttachmentContribution = Static<typeof ContextAttachmentContributionSchema>;

export const CustomActivityContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 事件 namespace（plugin.<pluginId>.<domain>）与 payload Schema */
    eventNamespace: Type.String({ minLength: 1, maxLength: 128 }),
    payloadSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type CustomActivityContribution = Static<typeof CustomActivityContributionSchema>;

export const SkillBundleContributionSchema = Type.Object(
  {
    ...ContributionBaseSchema.properties,
    /** 插件携带的 skills/ 目录（Phase 12 只登记，不激活） */
    skillsDir: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type SkillBundleContribution = Static<typeof SkillBundleContributionSchema>;

/** 插件声明的全部扩展点（Manifest.contributions） */
export const ContributionsSchema = Type.Object(
  {
    tool: Type.Optional(Type.Array(ToolContributionSchema, { maxItems: 256 })),
    command: Type.Optional(Type.Array(CommandContributionSchema, { maxItems: 256 })),
    provider: Type.Optional(Type.Array(ProviderContributionSchema, { maxItems: 128 })),
    route: Type.Optional(Type.Array(RouteContributionSchema, { maxItems: 128 })),
    page: Type.Optional(Type.Array(SurfaceContributionSchema, { maxItems: 64 })),
    widget: Type.Optional(Type.Array(SurfaceContributionSchema, { maxItems: 64 })),
    "chat-surface": Type.Optional(Type.Array(SurfaceContributionSchema, { maxItems: 64 })),
    background: Type.Optional(Type.Array(BackgroundContributionSchema, { maxItems: 128 })),
    hook: Type.Optional(Type.Array(HookContributionSchema, { maxItems: 128 })),
    config: Type.Optional(Type.Array(ConfigContributionSchema, { maxItems: 128 })),
    secret: Type.Optional(Type.Array(SecretContributionSchema, { maxItems: 128 })),
    "context-attachment": Type.Optional(Type.Array(ContextAttachmentContributionSchema, { maxItems: 128 })),
    "custom-activity": Type.Optional(Type.Array(CustomActivityContributionSchema, { maxItems: 128 })),
    "skill-bundle": Type.Optional(Type.Array(SkillBundleContributionSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type Contributions = Static<typeof ContributionsSchema>;
