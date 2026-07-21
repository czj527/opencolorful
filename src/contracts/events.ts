import { type Static, Type } from "typebox";

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
  "error",
] as const;

export type PlatformEventType = (typeof EVENT_TYPES)[number];

const EventPayloadSchema = Type.Union([
  Type.Object({ status: Type.String() }),
  Type.Object({ role: Type.String() }),
  Type.Object({ delta: Type.String() }),
  Type.Object({ role: Type.String(), delta: Type.String() }),
  Type.Object({ role: Type.String(), content: Type.String() }),
  Type.Object({ toolCallId: Type.String(), toolName: Type.String() }),
  Type.Object({ toolCallId: Type.String(), delta: Type.String() }),
  Type.Object({ toolCallId: Type.String(), result: Type.Unknown() }),
  Type.Object({ turnId: Type.String() }),
  Type.Object({ turnId: Type.String(), usage: Type.Optional(Type.Unknown()) }),
  Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Boolean() }),
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
