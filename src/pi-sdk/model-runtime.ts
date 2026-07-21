import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
} from "./types.js";

function registerProvider(runtime: ModelRuntime, provider: PiProviderDefinition): void {
  runtime.registerProvider(provider.providerId, {
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.protocol,
    ...(provider.headers ? { headers: { ...provider.headers } } : {}),
    models: provider.models.map((model) => ({
      id: model.modelId,
      name: model.name,
      reasoning: model.capabilities.reasoning,
      input: [...model.capabilities.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.capabilities.contextWindow,
      maxTokens: model.capabilities.maxTokens,
    })),
  });
}

export async function createPiModelRuntime(options: {
  readonly authPath: string;
  readonly providers: readonly PiProviderDefinition[];
}): Promise<PiModelRuntimeHandle> {
  const runtime = await ModelRuntime.create({
    authPath: options.authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  for (const provider of options.providers) {
    registerProvider(runtime, provider);
  }

  const summarize = (model: ReturnType<ModelRuntime["getModels"]>[number]): PiModelSummary => ({
    providerId: model.provider,
    modelId: model.id,
    name: model.name,
    protocol: model.api,
    baseUrl: model.baseUrl,
    capabilities: {
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    },
    credentialConfigured: runtime.getProviderAuthStatus(model.provider).configured,
  });

  return {
    async setApiKey(providerId, apiKey) {
      await runtime.login(providerId, "api_key", {
        async prompt() {
          return apiKey;
        },
        notify() {},
      });
    },
    credentialConfigured(providerId) {
      return runtime.getProviderAuthStatus(providerId).configured;
    },
    listConfiguredModels(): PiModelSummary[] {
      return options.providers.flatMap((provider) =>
        runtime.getModels(provider.providerId).map(summarize),
      );
    },
    listEnvironmentModels(): PiModelSummary[] {
      return runtime.getAvailableSnapshot().map(summarize);
    },
  };
}
