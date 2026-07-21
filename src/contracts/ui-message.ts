import { type Static, Type } from "typebox";

export const A2uiComponentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  component: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const A2uiServerMessageSchema = Type.Union([
  Type.Object({
    version: Type.Literal("v0.9.1"),
    createSurface: Type.Object({
      surfaceId: Type.String({ minLength: 1 }),
      catalogId: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal("v0.9.1"),
    updateComponents: Type.Object({
      surfaceId: Type.String({ minLength: 1 }),
      components: Type.Array(A2uiComponentSchema, { minItems: 1 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal("v0.9.1"),
    updateDataModel: Type.Object({
      surfaceId: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      value: Type.Optional(Type.Unknown()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    version: Type.Literal("v0.9.1"),
    deleteSurface: Type.Object({
      surfaceId: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export interface A2uiComponent {
  readonly id: string;
  readonly component: string;
  readonly [property: string]: unknown;
}

export type A2uiServerMessage =
  | {
      readonly version: "v0.9.1";
      readonly createSurface: {
        readonly surfaceId: string;
        readonly catalogId: string;
      };
    }
  | {
      readonly version: "v0.9.1";
      readonly updateComponents: {
        readonly surfaceId: string;
        readonly components: readonly A2uiComponent[];
      };
    }
  | {
      readonly version: "v0.9.1";
      readonly updateDataModel: {
        readonly surfaceId: string;
        readonly path?: string;
        readonly value?: unknown;
      };
    }
  | {
      readonly version: "v0.9.1";
      readonly deleteSurface: { readonly surfaceId: string };
    };

export const UiMessagePayloadSchema = Type.Union([
  Type.Object({
    format: Type.Literal("a2ui"),
    messages: Type.Array(A2uiServerMessageSchema, { minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    format: Type.Literal("tokui"),
    chunk: Type.String(),
  }, { additionalProperties: false }),
]);

export type UiMessagePayload =
  | { readonly format: "a2ui"; readonly messages: readonly A2uiServerMessage[] }
  | { readonly format: "tokui"; readonly chunk: string };

export const A2uiActionSchema = Type.Object({
  version: Type.Literal("v0.9.1"),
  action: Type.Object({
    name: Type.String({ minLength: 1 }),
    surfaceId: Type.String({ minLength: 1 }),
    sourceComponentId: Type.String({ minLength: 1 }),
    timestamp: Type.String({ minLength: 1 }),
    context: Type.Record(Type.String(), Type.Unknown()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type A2uiAction = Static<typeof A2uiActionSchema>;
