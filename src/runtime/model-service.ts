import type { RuntimePaths } from "../config/paths.js";
import type { ProviderStore } from "../config/provider-store.js";
import type { ProviderInput, ProviderSetting } from "../contracts/provider-settings.js";
import {
  createPiModelRuntime,
  type PiModelRuntimeHandle,
  type PiModelSummary,
  type PiResolvedModel,
} from "../pi-sdk/index.js";
import { instrument } from "../observability/instrument.js";

export interface ProviderView extends ProviderSetting {
  readonly credentialConfigured: boolean;
}

export class ModelService {
  private constructor(
    private readonly paths: RuntimePaths,
    private readonly store: ProviderStore,
    private runtime: PiModelRuntimeHandle,
  ) {}

  static async create(paths: RuntimePaths, store: ProviderStore): Promise<ModelService> {
    const runtime = await createPiModelRuntime({ authPath: paths.authFile, providers: store.list() });
    return new ModelService(paths, store, runtime);
  }

  listProviders(): ProviderView[] {
    return this.store.list().map((provider) => ({
      ...provider,
      credentialConfigured: this.runtime.credentialConfigured(provider.providerId),
    }));
  }

  listModels(): PiModelSummary[] {
    return this.store.list().length > 0
      ? this.runtime.listConfiguredModels()
      : this.runtime.listEnvironmentModels();
  }

  resolveModel(providerId: string, modelId: string): PiResolvedModel {
    return this.runtime.resolveModel(providerId, modelId);
  }

  getRuntime(): PiModelRuntimeHandle {
    return this.runtime;
  }

  async upsert(provider: ProviderInput, apiKey?: string): Promise<ProviderView> {
    const setting = this.store.upsert(provider);
    this.runtime = await createPiModelRuntime({
      authPath: this.paths.authFile,
      providers: this.store.list(),
    });
    if (apiKey !== undefined) {
      await this.runtime.setApiKey(setting.providerId, apiKey);
      // 凭据变更属 notable + audit 镜像（不记录 apiKey 本身）
      instrument.providerCredentialChanged(setting.providerId);
    } else {
      instrument.providerConfigured(setting.providerId);
    }
    return {
      ...setting,
      credentialConfigured: this.runtime.credentialConfigured(setting.providerId),
    };
  }
}
