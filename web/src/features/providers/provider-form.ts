export const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "pi-messages",
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export interface ProviderFormData {
  providerId: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelId: string;
  modelName: string;
  apiKey: string;
}

export interface ProviderFormErrors {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

export function validateProviderForm(data: ProviderFormData): ProviderFormErrors {
  const errors: ProviderFormErrors = {};

  if (!data.providerId.trim()) {
    errors.providerId = "Provider ID 不能为空";
  } else if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.providerId)) {
    errors.providerId = "Provider ID 只能包含小写字母、数字、点、横线和下划线";
  }

  if (!data.name.trim()) {
    errors.name = "名称不能为空";
  }

  if (!data.baseUrl.trim()) {
    errors.baseUrl = "Base URL 不能为空";
  } else {
    try {
      const url = new URL(data.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.baseUrl = "Base URL 必须是 HTTP 或 HTTPS";
      }
    } catch {
      errors.baseUrl = "Base URL 格式无效";
    }
  }

  if (!data.modelId.trim()) {
    errors.modelId = "模型 ID 不能为空";
  }

  return errors;
}

export function hasProviderFormErrors(errors: ProviderFormErrors): boolean {
  return Object.values(errors).some((e) => e !== undefined);
}
