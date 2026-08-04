import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 12 能力族（plans/phase-12.md §十）
//
// 权限结果按交集计算：
//   effective = manifest request ∩ installed grant ∩ agent binding grant
//               ∩ session/runtime policy ∩ Phase 9 sandbox policy
// 高风险权限变更必须 fail-closed，并与授权结果写入同一严格 Audit 生命周期。
// ═══════════════════════════════════════════════════════════════

export const CAPABILITY_KINDS = [
  "filesystem.read",
  "filesystem.write",
  "network.connect",
  "process.spawn",
  "secret.read-own",
  "provider.register",
  "tool.register",
  "route.register",
  "ui.surface",
  "ui.host.external-open",
  "ui.host.clipboard",
  "resource.open",
  "resource.pick",
  "background.run",
  "hook.register",
  "activity.emit",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** 插件声明的能力请求（Manifest.permissions 或运行时扩展请求） */
export const PermissionRequestSchema = Type.Object(
  {
    capability: Type.Union(CAPABILITY_KINDS.map((kind) => Type.Literal(kind))),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type PermissionRequest = Static<typeof PermissionRequestSchema>;

export const GRANT_DECISIONS = ["allowed", "denied"] as const;
export type GrantDecision = (typeof GRANT_DECISIONS)[number];

/**
 * 平台级授权：pluginId × capability 的授权结果。
 * revision 单调递增，权限变更通过新 revision 观察（Agent binding 引用 grant revision）。
 */
export const PluginGrantSchema = Type.Object(
  {
    pluginId: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" }),
    capability: Type.Union(CAPABILITY_KINDS.map((kind) => Type.Literal(kind))),
    decision: Type.Union(GRANT_DECISIONS.map((decision) => Type.Literal(decision))),
    revision: Type.Integer({ minimum: 1 }),
    grantedAt: Type.String({ minLength: 1, maxLength: 64 }),
    /** 授权主体（用户/平台），供 Audit 归责 */
    grantedBy: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type PluginGrant = Static<typeof PluginGrantSchema>;

/** 一次权限变更（started → 领域写入 → completed/failed 严格 Audit）的输入 */
export const GrantChangeInputSchema = Type.Object(
  {
    pluginId: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" }),
    capability: Type.Union(CAPABILITY_KINDS.map((kind) => Type.Literal(kind))),
    decision: Type.Union(GRANT_DECISIONS.map((decision) => Type.Literal(decision))),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type GrantChangeInput = Static<typeof GrantChangeInputSchema>;
