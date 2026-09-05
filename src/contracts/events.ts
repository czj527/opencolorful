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
