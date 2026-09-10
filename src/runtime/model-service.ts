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
import { assertDurableAudit, type AuditRecorder } from "../observability/audit-recorder.js";

export interface ProviderView extends ProviderSetting {
  readonly credentialConfigured: boolean;
}

export class ModelService {
  /**
   * Provider 配置代次：upsert（端点/模型清单/凭据变更）后递增。
   * runtime-bootstrap 将其纳入运行中会话的 runtime 重建白名单——
   * 修改 Provider 配置后，已打开会话的下一回合自动使用新配置，无需新建会话。
   */
  private version = 0;

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

  /** Provider 配置代次（单调递增）：runtime 重建白名单的一项 */
  get configVersion(): number {
    return this.version;
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
    // 评审 P0（第三轮）：凭据变更属 fail-closed 清单——先落 durable audit（严格路径），
    // 再写入 provider 设置与 auth 文件。只接受 accepted/accepted-idempotent；
    // 审计未配置或返回 rejected 一律抛错拒绝操作（auth 文件写入后无法回滚旧凭据）。
    if (apiKey !== undefined) {
      if (this.audit === undefined) {
        throw new Error("可观测性未初始化，凭据修改拒绝执行");
      }
      assertDurableAudit(this.audit.appendStrict({
        eventName: "audit.provider.credential_changed",
        payload: {
          action: "provider.credential.changed",
          decision: "allowed",
          changedFields: ["apiKey"],
        },
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        target: { kind: "provider", id: provider.providerId },
      }), "Provider 凭据变更");
    }
    const setting = this.store.upsert(provider);
    this.runtime = await createPiModelRuntime({
      authPath: this.paths.authFile,
      providers: this.store.list(),
    });
    this.version += 1;
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
