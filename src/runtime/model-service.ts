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
import type { AuditRecorder } from "../observability/audit-recorder.js";

export interface ProviderView extends ProviderSetting {
  readonly credentialConfigured: boolean;
}

export class ModelService {
  private constructor(
    private readonly paths: RuntimePaths,
    private readonly store: ProviderStore,
    private runtime: PiModelRuntimeHandle,
    private readonly audit?: AuditRecorder,
  ) {}

  static async create(
    paths: RuntimePaths,
    store: ProviderStore,
    audit?: AuditRecorder,
  ): Promise<ModelService> {
    const runtime = await createPiModelRuntime({ authPath: paths.authFile, providers: store.list() });
    return new ModelService(paths, store, runtime, audit);
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
    // 评审 P0-1：凭据变更属 fail-closed 清单——先落 durable audit（严格路径，
    // 失败即抛错拒绝操作），再写入 provider 设置与 auth 文件。
    // 审计先行是因为 auth 文件写入后无法回滚旧凭据。
    if (apiKey !== undefined && this.audit !== undefined) {
      this.audit.appendStrict({
        eventName: "audit.provider.credential_changed",
        payload: {
          action: "provider.credential.changed",
          decision: "allowed",
          changedFields: ["apiKey"],
        },
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "provider", id: provider.providerId },
      });
    }
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
