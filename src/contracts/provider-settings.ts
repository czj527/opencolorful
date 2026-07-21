import { Type } from "typebox";
import { Value } from "typebox/value";

export const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "pi-messages",
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

const ModelCapabilitiesSchema = Type.Object(
  {
    reasoning: Type.Boolean(),
    input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
      minItems: 1,
      uniqueItems: true,
    }),
    contextWindow: Type.Integer({ minimum: 1 }),
    maxTokens: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ProviderModelSettingSchema = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    capabilities: ModelCapabilitiesSchema,
  },
  { additionalProperties: false },
);

export const ProviderInputSchema = Type.Object(
  {
    providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    protocol: Type.Union(PROVIDER_PROTOCOLS.map((protocol) => Type.Literal(protocol))),
    baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    models: Type.Array(ProviderModelSettingSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const ProviderSettingSchema = Type.Object(
  {
    providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    protocol: Type.Union(PROVIDER_PROTOCOLS.map((protocol) => Type.Literal(protocol))),
    baseUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    models: Type.Array(ProviderModelSettingSchema, { minItems: 1 }),
    credentialRef: Type.String({ pattern: "^provider:[a-z0-9][a-z0-9._-]{0,63}$" }),
  },
  { additionalProperties: false },
);

export const ProviderSettingsDocumentSchema = Type.Object(
  {
    version: Type.Literal(1),
    providers: Type.Array(ProviderSettingSchema),
  },
  { additionalProperties: false },
);

export const ProviderUpdateRequestSchema = Type.Object(
  {
    provider: ProviderInputSchema,
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export interface ProviderModelCapabilities {
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderModelSetting {
  readonly modelId: string;
  readonly name: string;
  readonly capabilities: ProviderModelCapabilities;
}

export interface ProviderInput {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly models: ProviderModelSetting[];
}

export interface ProviderSetting extends ProviderInput {
  readonly credentialRef: string;
}

export interface ProviderSettingsDocument {
  readonly version: 1;
  readonly providers: ProviderSetting[];
}

export interface ProviderUpdateRequest {
  readonly provider: ProviderInput;
  readonly apiKey?: string;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

export class ProviderSettingsValidationError extends Error {}

function validateProviderBusinessRules(provider: ProviderInput): void {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new ProviderSettingsValidationError("baseUrl 必须是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ProviderSettingsValidationError("baseUrl 只允许不含凭据的 HTTP 或 HTTPS URL");
  }

  const modelIds = new Set<string>();
  for (const model of provider.models) {
    if (modelIds.has(model.modelId)) {
      throw new ProviderSettingsValidationError("同一 Provider 下的 modelId 不能重复");
    }
    modelIds.add(model.modelId);
    if (model.capabilities.maxTokens > model.capabilities.contextWindow) {
      throw new ProviderSettingsValidationError("maxTokens 不能大于 contextWindow");
    }
  }

  for (const headerName of Object.keys(provider.headers ?? {})) {
    if (SENSITIVE_HEADERS.has(headerName.toLowerCase())) {
      throw new ProviderSettingsValidationError("凭据 Header 必须通过 AuthStorage 配置");
    }
  }
}

export function parseProviderInput(value: unknown): ProviderInput {
  if (!Value.Check(ProviderInputSchema, value)) {
    throw new ProviderSettingsValidationError("Provider 设置结构无效");
  }
  const provider = value as ProviderInput;
  validateProviderBusinessRules(provider);
  return provider;
}

export function parseProviderUpdateRequest(value: unknown): ProviderUpdateRequest {
  if (!Value.Check(ProviderUpdateRequestSchema, value)) {
    throw new ProviderSettingsValidationError("Provider 更新请求结构无效");
  }
  const request = value as ProviderUpdateRequest;
  parseProviderInput(request.provider);
  return request;
}

export function parseProviderSettingsDocument(value: unknown): ProviderSettingsDocument {
  if (!Value.Check(ProviderSettingsDocumentSchema, value)) {
    throw new ProviderSettingsValidationError("Provider 配置文件结构无效");
  }
  const document = value as ProviderSettingsDocument;
  const providerIds = new Set<string>();
  for (const provider of document.providers) {
    validateProviderBusinessRules(provider);
    if (providerIds.has(provider.providerId)) {
      throw new ProviderSettingsValidationError("Provider 配置中存在重复 providerId");
    }
    providerIds.add(provider.providerId);
  }
  return document;
}
