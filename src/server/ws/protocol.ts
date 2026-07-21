import { type Static, Type } from "typebox";

export const WsServerMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal("event"),
    payload: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("ack"),
    requestId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("already-stopped"),
      Type.Literal("rejected"),
    ]),
  }),
  Type.Object({
    type: Type.Literal("error"),
    requestId: Type.Optional(Type.String({ minLength: 1 })),
    code: Type.String(),
    message: Type.String(),
  }),
]);

export type WsServerMessage = Static<typeof WsServerMessageSchema>;

export function serializeMessage(message: WsServerMessage): string {
  return JSON.stringify(message);
}
