import type { CapabilityKind, PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import type { TraceContext } from "../../../contracts/observability.js";
import { isKnownCapability } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import { assertContributionInSnapshot, checkCapabilities, recordCapabilityDenied, serializedBytes } from "./shared.js";
import type { SecretService } from "./secret-contribution.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Provider Contribution（plans/phase-12.md §8.3）
//
// - Provider 只通过稳定 Port 注册能力和配置 Schema；
// - 凭据走插件专属 Secret namespace（SecretService 声明接口）；
//   Provider 不能读取其他 Provider 凭据——SecretService.readSecret
//   按 pluginId + secret.read-own 授权校验；
// - Provider 健康检查、模型目录和请求日志走平台接口（统一
//   RuntimeHost.invoke，contributionKind=provider）。
// ═══════════════════════════════════════════════════════════════

export const PROVIDER_MAX_PARAMS_BYTES = 512 * 1024;

export interface ProviderDescriptor {
  readonly pluginId: string;
  readonly providerId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly kind?: string;
  readonly configSchema?: unknown;
}

/** Provider 凭据 Secret 绑定声明（本阶段只声明接口，T9 接入 plugin-secrets.json）。 */
export interface ProviderCredentialBinding {
  readonly pluginId: string;
  readonly providerId: string;
  /** 该 Provider 使用的插件专属 Secret 名称（由 SecretService 授权校验） */
  readonly secretNames: readonly string[];
}

export type ProviderInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: "not-registered" | "not-in-snapshot" | "too-large" | "denied" | "not-running" | "runtime-error";
      readonly message: string;
      readonly deniedBy?: string;
      readonly reasonCode?: string;
    };

export interface ProviderServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly runtimeHost: RuntimeHost;
  readonly secrets: SecretService;
}

export class ProviderService {
  /** pluginId:providerId → secretNames（接口声明；凭据值由 SecretService 托管） */
  private readonly credentialBindings = new Map<string, ProviderCredentialBinding>();

  constructor(private readonly deps: ProviderServiceDeps) {}

  listProviders(): ProviderDescriptor[] {
    const result: ProviderDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "provider") {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getProvider(pluginId: string, providerId: string): ProviderDescriptor | undefined {
    const contribution = this.deps.registry.get(pluginId, providerId);
    if (contribution === undefined || contribution.kind !== "provider") {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /** 声明 Provider 凭据 Secret 绑定（接口：凭据走插件专属 Secret namespace）。 */
  bindCredentialSecrets(pluginId: string, providerId: string, secretNames: readonly string[]): void {
    this.credentialBindings.set(`${pluginId}:${providerId}`, {
      pluginId,
      providerId,
      secretNames: [...secretNames],
    });
  }

  getCredentialBinding(pluginId: string, providerId: string): ProviderCredentialBinding | undefined {
    return this.credentialBindings.get(`${pluginId}:${providerId}`);
  }

  /** Provider 调用（operation 由调用方指定，例如 chat.completions / models.list）。 */
  async invoke(input: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: string;
    readonly params?: unknown;
    readonly agentId: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
    readonly trace?: TraceContext;
    readonly signal?: AbortSignal;
  }): Promise<ProviderInvokeResult> {
    const { pluginId, providerId, agentId } = input;
    const contribution = this.deps.registry.get(pluginId, providerId);
    if (contribution === undefined || contribution.kind !== "provider") {
      return { ok: false, code: "not-registered", message: `Provider 未登记：${pluginId}.${providerId}` };
    }

    const snapshotCheck = assertContributionInSnapshot({ snapshot: input.snapshot, pluginId, contributionId: providerId });
    if (!snapshotCheck.ok) {
      return { ok: false, code: "not-in-snapshot", message: snapshotCheck.reason };
    }

    if (serializedBytes(input.params) > PROVIDER_MAX_PARAMS_BYTES) {
      return { ok: false, code: "too-large", message: `Provider 参数超过大小限制（${PROVIDER_MAX_PARAMS_BYTES} 字节）` };
    }

    const manifestPermissions = this.deps.registry.getActive(pluginId)?.manifestPermissions;
    const capabilities: CapabilityKind[] = ["provider.register"];
    for (const required of contribution.requiredCapabilities) {
      if (isKnownCapability(required)) {
        capabilities.push(required);
      }
    }
    const guard = checkCapabilities({
      policy: this.deps.policy,
      pluginId,
      agentId,
      capabilities,
      manifestPermissions,
      state: input.state,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!guard.allowed) {
      recordCapabilityDenied({
        eventName: "plugin.sandbox.denied",
        pluginId,
        contributionId: providerId,
        agentId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        capability: guard.capability,
        deniedBy: guard.deniedBy,
        reason: guard.reason ?? "权限不足",
      });
      return {
        ok: false,
        code: "denied",
        message: `Provider ${providerId} 调用被拒绝：${guard.reason ?? "权限不足"}`,
        ...(guard.deniedBy !== undefined ? { deniedBy: guard.deniedBy } : {}),
        reasonCode: `capability-${guard.capability ?? "unknown"}`,
      };
    }

    const result = await this.deps.runtimeHost.invoke({
      pluginId,
      contributionKind: "provider",
      contributionId: providerId,
      method: providerId,
      params: { operation: input.operation, ...(input.params !== undefined ? { params: input.params } : {}) },
      agentId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "not-running" ? "not-running" : "runtime-error",
        message: result.message.slice(0, 400),
      };
    }
    return { ok: true, result: result.result };
  }

  // ── private helpers ───────────────────────────────────────────

  private toDescriptor(contribution: RegisteredContribution): ProviderDescriptor | undefined {
    if (contribution.kind !== "provider") {
      return undefined;
    }
    const descriptor: ProviderDescriptor = {
      pluginId: contribution.pluginId,
      providerId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
    };
    const kind = contribution.spec["kind"];
    const withKind =
      typeof kind === "string" && kind.length > 0 ? { ...descriptor, kind } : descriptor;
    const configSchema = contribution.spec["configSchema"];
    return isSchemaObject(configSchema) ? { ...withKind, configSchema } : withKind;
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
