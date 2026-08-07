// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：Subagent Stores 共享类型（plans/phase-14.md §5.2 / §22.1）
//
// - SubagentOwnership：§22.1 要求所有 Thread/Run/Message/Artifact/Mailbox
//   查询必须同时过滤 ownerAgentId + parentSessionId；本类型是归属上下文的
//   唯一携带方式（从工具调用上下文盖章，不由模型参数提供）。
// - SUBAGENT_MESSAGE_DELIVERY_STATUSES：subagent_messages.delivery_status
//   列取值（migrations v12 CHECK 的四个值）。协议 Envelope 不含该字段，
//   它是 Store 层的投递状态，不在 contracts 中重复声明。
// ═══════════════════════════════════════════════════════════════

/** §22.1 归属上下文：ownerAgentId（父永久 Agent）+ parentSessionId（父 Session） */
export interface SubagentOwnership {
  readonly ownerAgentId: string;
  readonly parentSessionId: string;
}

/** subagent_messages.delivery_status（migrations v12 CHECK 取值） */
export const SUBAGENT_MESSAGE_DELIVERY_STATUSES = ["queued", "delivering", "delivered", "failed"] as const;
export type SubagentMessageDeliveryStatus = (typeof SUBAGENT_MESSAGE_DELIVERY_STATUSES)[number];
