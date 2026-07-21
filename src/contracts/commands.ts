import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const ClientCommandSchema = Type.Union([
  Type.Object({
    protocolVersion: Type.Literal(1),
    requestId: Type.String({ minLength: 1 }),
    type: Type.Literal("session.abort"),
    sessionId: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    protocolVersion: Type.Literal(1),
    requestId: Type.String({ minLength: 1 }),
    type: Type.Literal("session.compact"),
    sessionId: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    protocolVersion: Type.Literal(1),
    requestId: Type.String({ minLength: 1 }),
    type: Type.Literal("session.unsubscribe"),
    sessionId: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    protocolVersion: Type.Literal(1),
    requestId: Type.String({ minLength: 1 }),
    type: Type.Literal("session.subscribe"),
    sessionId: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    protocolVersion: Type.Literal(1),
    requestId: Type.String({ minLength: 1 }),
    type: Type.Literal("stream.resume"),
    sessionId: Type.String({ minLength: 1 }),
    streamId: Type.String({ minLength: 1 }),
    lastSequence: Type.Integer({ minimum: 0 }),
  }),
]);

export type ClientCommand = Static<typeof ClientCommandSchema>;

export interface CommandValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function validateClientCommand(value: unknown): CommandValidationResult {
  return isClientCommand(value)
    ? { ok: true, issues: [] }
    : { ok: false, issues: ["命令结构无效"] };
}

export function isClientCommand(value: unknown): value is ClientCommand {
  return Value.Check(ClientCommandSchema, value);
}
