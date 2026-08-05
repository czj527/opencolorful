import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Runtime IPC（plans/phase-12.md §9.2）
//
// - Node/Python Runtime 使用版本化 JSON-RPC/stdio；
// - 请求包含平台签发的一次性调用 token 和只读 Trace carrier；
// - token 绑定 pluginId + runtimeInstanceId + operationId，单次消费；
// - 插件返回的 actor/executor/scope/trace 一律不可信，由平台覆盖；
// - stdout/stderr 不作为协议通道。
// ═══════════════════════════════════════════════════════════════

export const PLUGIN_IPC_VERSION = 1 as const;

/** 平台签发的一次性 carrier：worker 回传时校验并单次消费 */
export const PluginIpcCarrierSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 128 }),
    runtimeInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    operationId: Type.String({ minLength: 1, maxLength: 128 }),
    token: Type.String({ minLength: 16, maxLength: 128 }),
    traceId: Type.String({ minLength: 1, maxLength: 128 }),
    spanId: Type.String({ minLength: 1, maxLength: 128 }),
    issuedAt: Type.String({ minLength: 1, maxLength: 64 }),
    expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * 触发本次执行的 Agent/Session 上下文（平台签发，worker 回传时按
     * token 绑定校验，不允许 worker 篡改/伪造）；向后兼容：旧 carrier
     * 无此字段。
     */
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type PluginIpcCarrier = Static<typeof PluginIpcCarrierSchema>;

/** JSON-RPC 请求（版本化） */
export const PluginRpcRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Union([Type.Integer(), Type.String({ minLength: 1, maxLength: 128 })]),
    method: Type.String({ minLength: 1, maxLength: 128 }),
    params: Type.Optional(Type.Unknown()),
    /** 平台签发的一次性 carrier（Host → worker） */
    carrier: Type.Optional(PluginIpcCarrierSchema),
  },
  { additionalProperties: false },
);
export type PluginRpcRequest = Static<typeof PluginRpcRequestSchema>;

export const PluginRpcErrorSchema = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String({ minLength: 1, maxLength: 512 }),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type PluginRpcError = Static<typeof PluginRpcErrorSchema>;

/** JSON-RPC 响应：成功携带 result；失败携带 error（二选一） */
export const PluginRpcResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Union([Type.Integer(), Type.String({ minLength: 1, maxLength: 128 })]),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(PluginRpcErrorSchema),
  },
  { additionalProperties: false },
);
export type PluginRpcResponse = Static<typeof PluginRpcResponseSchema>;

/** worker 对平台的通知（无 id）：只能用于请求 Host 执行领域操作，不能写 Store */
export const PluginRpcNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.String({ minLength: 1, maxLength: 128 }),
    params: Type.Optional(Type.Unknown()),
    carrier: Type.Optional(PluginIpcCarrierSchema),
  },
  { additionalProperties: false },
);
export type PluginRpcNotification = Static<typeof PluginRpcNotificationSchema>;
