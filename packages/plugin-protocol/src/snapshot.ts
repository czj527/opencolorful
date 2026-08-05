import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Agent 绑定与运行时快照（plans/phase-12.md §十一）
//
// - 插件安装在平台级，能力授权和可见性在 Agent 级；
// - 不在 Agent identity/base-color 中保存插件状态；
// - 绑定、配置或版本变更从下一 turn 生效；
// - in-flight turn 使用不可变 PluginExecutionSnapshot。
// ═══════════════════════════════════════════════════════════════

/** Agent 插件绑定：Agent × pluginId 的可见性与允许的 contributions */
export const AgentPluginBindingSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    pluginId: Type.String({ minLength: 1, maxLength: 128 }),
    /** 允许该 Agent 使用的 contribution id 列表（空 = 全部启用） */
    contributions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512 }),
    /** 引用平台 grant revision：绑定只引用授权，不替代授权 */
    grantRevision: Type.Integer({ minimum: 1 }),
    enabled: Type.Boolean(),
    updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type AgentPluginBinding = Static<typeof AgentPluginBindingSchema>;

export const PLUGIN_EXECUTION_SNAPSHOT_VERSION = 1 as const;

/**
 * 不可变执行快照：一次 in-flight turn 使用同一快照，不能中途换工具实现。
 * 每次工具调用记录实际插件版本和 snapshot id，便于回放和诊断。
 */
export const PluginExecutionSnapshotSchema = Type.Object(
  {
    version: Type.Literal(PLUGIN_EXECUTION_SNAPSHOT_VERSION),
    snapshotId: Type.String({ minLength: 1, maxLength: 128 }),
    pluginId: Type.String({ minLength: 1, maxLength: 128 }),
    pluginVersion: Type.String({ minLength: 1, maxLength: 128 }),
    runtimeKind: Type.String({ minLength: 1, maxLength: 64 }),
    runtimeInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    grantRevision: Type.Integer({ minimum: 1 }),
    bindingRevision: Type.Integer({ minimum: 1 }),
    /** 快照生效时允许的 contribution id：绑定列表的交集；绑定空列表（允许全部）时冻结为创建时刻插件登记的全部贡献集 */
    contributions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512 }),
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type PluginExecutionSnapshot = Static<typeof PluginExecutionSnapshotSchema>;
