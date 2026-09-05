import { type Static, Type } from "typebox";

import {
  MemoryAgentPayloadSchema,
  MemoryRecallPayloadSchema,
  MemoryStrengthChangedPayloadSchema,
  MemoryUpdatedPayloadSchema,
} from "./memory.js";

export const EVENT_TYPES = [
  "health.changed",
  "session.status",
  "message.started",
  "message.delta",
  "message.completed",
  "thinking.delta",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "plan.updated",
  "session.branch.switched",
  "session.branches.changed",
  // 注意：todo.updated 本波次（B2）只声明契约；写入方（durable todo 工具/store）
  // 由波次 B5 实现，当前没有任何 emitter。
  "todo.updated",
  "attachment.available",
  "session.compacting",
  "session.compacted",
  "sandbox.denied",
  "sandbox.preflight-denied",
  "memory.updated",
  "memory.recall.started",
  "memory.recall.layer_changed",
  "memory.recall.completed",
  "memory.recall.empty",
  "memory.recall.failed",
  "memory.recall.cancelled",
  "memory.agent.started",
  "memory.agent.layer_changed",
  "memory.agent.processing",
  "memory.agent.completed",
  "memory.agent.deferred",
  "memory.agent.failed",
  "memory.strength.changed",
  "error",
] as const;

export type PlatformEventType = (typeof EVENT_TYPES)[number];

export const TokenUsageSchema = Type.Object({
  input: Type.Integer({ minimum: 0 }),
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),
  cacheWrite: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Integer({ minimum: 0 }),
});
export type TokenUsage = Static<typeof TokenUsageSchema>;

/**
 * 波次 B2/B5：会话级 durable todo 条目视图。B2 只声明契约（todo.updated 事件
 * 负载）；写入方（todo_write 工具 + store + 路由）由波次 B5 实现。
 */
export const SessionTodoItemSchema = Type.Object({
  content: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
  ]),
  priority: Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  activeForm: Type.Optional(Type.String()),
});
export type SessionTodoItemView = Static<typeof SessionTodoItemSchema>;

export const SessionTodoItemsPayloadSchema = Type.Object({
  items: Type.Array(SessionTodoItemSchema),
});

export const SessionBranchSwitchedPayloadSchema = Type.Object({
  branchId: Type.String({ minLength: 1 }),
});

export const SessionBranchesChangedPayloadSchema = Type.Object({
  reason: Type.Union([
    Type.Literal("regenerate"),
    Type.Literal("fork"),
    Type.Literal("switch"),
  ]),
});
export type SessionBranchesChangedReason = Static<typeof SessionBranchesChangedPayloadSchema>["reason"];

export const ContextUsageSchema = Type.Object({
  tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  contextWindow: Type.Integer({ minimum: 1 }),
  percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
export type ContextUsage = Static<typeof ContextUsageSchema>;

const EventPayloadSchema = Type.Union([
  Type.Object({ status: Type.String() }),
  Type.Object({ role: Type.String() }),
  Type.Object({ delta: Type.String() }),
  Type.Object({ role: Type.String(), delta: Type.String() }),
  Type.Object({ role: Type.String(), content: Type.String() }),
  Type.Object({ toolCallId: Type.String(), toolName: Type.String() }),
  Type.Object({ toolCallId: Type.String(), delta: Type.String() }),
  Type.Object({ toolCallId: Type.String(), result: Type.Unknown() }),
  Type.Object({
    turnId: Type.String(),
    usage: Type.Optional(TokenUsageSchema),
    context: Type.Optional(ContextUsageSchema),
  }),
  Type.Object({ items: Type.Array(Type.String()) }),
  Type.Object({
    attachmentId: Type.String(),
    name: Type.String(),
    mimeType: Type.Optional(Type.String()),
  }),
  Type.Object({ reason: Type.String() }),
  // turn.cancelled/turn.interrupted 终态负载（A8a 可选字段：turnId/usage 供用量摄取；
  // usage 仅在终态化时最后一条 turn 账目可得才附上，缺省 = 无账目）
  Type.Object({
    reason: Type.String(),
    turnId: Type.Optional(Type.String()),
    usage: Type.Optional(TokenUsageSchema),
  }),
  // turn.failed 终态负载（A4 CHAT-06；A8a 可选 turnId/usage 同上）
  Type.Object({
    errorMessage: Type.String(),
    turnId: Type.Optional(Type.String()),
    usage: Type.Optional(TokenUsageSchema),
  }),
  Type.Object({
    reason: Type.String(),
    tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
    tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
    summary: Type.Optional(Type.String()),
    aborted: Type.Optional(Type.Boolean()),
    errorMessage: Type.Optional(Type.String()),
  }),
  Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Boolean() }),
  // 波次 B2：分支切换/分支集合变化（regenerate/fork/switch）会话流事件
  SessionBranchSwitchedPayloadSchema,
  SessionBranchesChangedPayloadSchema,
  // 波次 B2 声明、B5 实现：durable todo 列表整体替换事件
  SessionTodoItemsPayloadSchema,
  MemoryUpdatedPayloadSchema,
  MemoryRecallPayloadSchema,
  MemoryAgentPayloadSchema,
  MemoryStrengthChangedPayloadSchema,
]);

export const PlatformEventEnvelopeSchema = Type.Object({
  protocolVersion: Type.Literal(1),
  eventId: Type.String({ minLength: 1 }),
  sessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  streamId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  payload: EventPayloadSchema,
});

export type PlatformEventEnvelope = Static<typeof PlatformEventEnvelopeSchema>;

export interface PlatformEvent<T = unknown> {
  readonly protocolVersion: 1;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly streamId: string | null;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: PlatformEventType;
  readonly payload: T;
}
