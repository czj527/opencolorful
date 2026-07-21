import { type Static, Type } from "typebox";

export const UiMessagePayloadSchema = Type.Union([
  Type.Object({
    format: Type.Literal("a2ui"),
    message: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    format: Type.Literal("tokui"),
    chunk: Type.String(),
  }),
]);

export type UiMessagePayload = Static<typeof UiMessagePayloadSchema>;

export const A2uiActionSchema = Type.Object({
  actionName: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  surfaceId: Type.String({ minLength: 1 }),
  sourceComponentId: Type.String({ minLength: 1 }),
  timestamp: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type A2uiAction = Static<typeof A2uiActionSchema>;
