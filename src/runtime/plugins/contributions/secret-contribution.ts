import type { ActorRef, ExecutorRef, TraceContext } from "../../../contracts/observability.js";
import type { PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { ContributionRegistry } from "./contribution-registry.js";
import { runStrictAuditLifecycle } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Secret Contribution（plans/phase-12.md §8.7）
//
// - Secret 只声明名称、用途和校验规则，Manifest 不保存值；
// - UI 不获得 Secret 原文；listSecretNames 只返回名称；
// - Runtime 只能读取自身声明并已授权的 Secret：readSecret 必须携带
//   Agent 上下文并经 EffectivePolicy 校验 secret.read-own；
// - Secret 值绝不进入日志/Trace/payload/错误消息：本服务全部签名
//   只有引用/名称/布尔，没有回显路径；
// - 变更走 audit.plugin.secret_change_* 三阶段严格审计（fail-closed）；
// - 存储使用占位接口（PluginSecretStore），T9 接入 auth/plugin-secrets.json
//   （paths.pluginSecrets）。明文存储但 UI/日志/support bundle 一律不返回原文。
// ═══════════════════════════════════════════════════════════════

/** 占位 Secret Store：内存实现；T9 将替换为 plugin-secrets.json 持久化实现。 */
export interface PluginSecretStore {
  get(pluginId: string, secretName: string): string | undefined;
  set(pluginId: string, secretName: string, value: string): void;
  has(pluginId: string, secretName: string): boolean;
  listNames(pluginId: string): string[];
  remove(pluginId: string, secretName: string): void;
}

export class InMemorySecretStore implements PluginSecretStore {
  private readonly values = new Map<string, string>();

  get(pluginId: string, secretName: string): string | undefined {
    return this.values.get(this.key(pluginId, secretName));
  }

  set(pluginId: string, secretName: string, value: string): void {
    this.values.set(this.key(pluginId, secretName), value);
  }

  has(pluginId: string, secretName: string): boolean {
    return this.values.has(this.key(pluginId, secretName));
  }

  listNames(pluginId: string): string[] {
    const prefix = `${pluginId}\u0000`;
    const names: string[] = [];
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        names.push(key.slice(prefix.length));
      }
    }
    return names.sort();
  }

  remove(pluginId: string, secretName: string): void {
    this.values.delete(this.key(pluginId, secretName));
  }

  private key(pluginId: string, secretName: string): string {
    return `${pluginId}\u0000${secretName}`;
  }
}

export interface SecretDescriptor {
  readonly pluginId: string;
  readonly secretName: string;
  readonly purpose?: string;
}

export class SecretAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAccessError";
  }
}

export interface SecretServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly store: PluginSecretStore;
  readonly audit: AuditRecorder;
  readonly now?: () => Date;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-secrets" };
const ACTION = "secret.change";
const CHANGED_FIELDS = ["secretName"] as const;

export class SecretService {
  private readonly now: () => Date;
  /** 插件已声明的 Secret 名称集合（来自 Manifest，无值） */
  private readonly declared = new Map<string, Set<string>>();

  constructor(private readonly deps: SecretServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 登记插件声明的 Secret（Manifest 声明，无值）。 */
  declareSecret(pluginId: string, secretName: string, purpose?: string): void {
    this.validateSecretName(secretName);
    const set = this.declared.get(pluginId) ?? new Set<string>();
    set.add(secretName);
    this.declared.set(pluginId, set);
    void purpose;
  }

  /** 插件已声明的 Secret 名称（不含值）。 */
  listSecretNames(pluginId: string): string[] {
    return [...(this.declared.get(pluginId) ?? [])].sort();
  }

  listDeclaredSecrets(): SecretDescriptor[] {
    const result: SecretDescriptor[] = [];
    for (const [pluginId, names] of this.declared) {
      for (const secretName of names) {
        result.push({ pluginId, secretName });
      }
    }
    return result;
  }

  hasSecret(pluginId: string, secretName: string): boolean {
    return this.deps.store.has(pluginId, secretName);
  }

  /** 写入/更新 Secret 值（变更走严格审计三阶段；值不进入任何日志/payload）。 */
  setSecret(input: { pluginId: string; secretName: string; value: string; actor: ActorRef }): void {
    const { pluginId, secretName, value, actor } = input;
    this.validateSecretName(secretName);
    const beforeRevision = this.deps.store.has(pluginId, secretName) ? "1" : "0";
    // P0-3 审计补偿：completed 审计失败时把旧值写回（FileSecretStore 先盘后内存，
    // 保证 best-effort 恢复本身是原子的）；新写入本身失败时 store 已原子回滚。
    const previousValue = this.deps.store.get(pluginId, secretName);
    const operationId = `secret-change-${pluginId.slice(0, 64)}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const trace = this.newTrace(operationId);
    runStrictAuditLifecycle(
      {
        audit: this.deps.audit,
        trace,
        actor,
        executor: EXECUTOR,
        target: { kind: "plugin", id: pluginId },
        scope: { pluginId },
        startEventName: "audit.plugin.secret_change_started",
        completedEventName: "audit.plugin.secret_change_completed",
        failedEventName: "audit.plugin.secret_change_failed",
        action: ACTION,
        beforeRevision,
        afterRevision: "1",
        changedFields: CHANGED_FIELDS,
        rollback: () => {
          if (previousValue !== undefined) {
            this.deps.store.set(pluginId, secretName, previousValue);
          } else {
            this.deps.store.remove(pluginId, secretName);
          }
        },
      },
      () => {
        this.deps.store.set(pluginId, secretName, value);
      },
    );
  }

  /** 移除 Secret（不返回原值；变更走严格审计）。 */
  removeSecret(input: { pluginId: string; secretName: string; actor: ActorRef }): void {
    const { pluginId, secretName, actor } = input;
    this.validateSecretName(secretName);
    const beforeRevision = this.deps.store.has(pluginId, secretName) ? "1" : "0";
    // P0-3 审计补偿：completed 审计失败时恢复旧值
    const previousValue = this.deps.store.get(pluginId, secretName);
    const operationId = `secret-change-${pluginId.slice(0, 64)}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const trace = this.newTrace(operationId);
    runStrictAuditLifecycle(
      {
        audit: this.deps.audit,
        trace,
        actor,
        executor: EXECUTOR,
        target: { kind: "plugin", id: pluginId },
        scope: { pluginId },
        startEventName: "audit.plugin.secret_change_started",
        completedEventName: "audit.plugin.secret_change_completed",
        failedEventName: "audit.plugin.secret_change_failed",
        action: ACTION,
        beforeRevision,
        afterRevision: "0",
        changedFields: CHANGED_FIELDS,
        rollback: () => {
          if (previousValue !== undefined) {
            this.deps.store.set(pluginId, secretName, previousValue);
          }
        },
      },
      () => {
        this.deps.store.remove(pluginId, secretName);
      },
    );
  }

  /**
   * 读取自身已授权 Secret：必须携带 Agent 上下文，secret.read-own 经
   * EffectivePolicy 校验（含 in-flight 快照状态）。未授权抛 SecretAccessError，
   * 未找到返回 undefined。值只通过返回值传递，绝不打日志。
   */
  readSecret(input: {
    readonly pluginId: string;
    readonly secretName: string;
    readonly agentId: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
  }): string | undefined {
    const { pluginId, secretName, agentId } = input;
    if (!this.isDeclared(pluginId, secretName)) {
      throw new SecretAccessError("插件未声明该 Secret");
    }
    const manifestPermissions = this.deps.registry.getActive(pluginId)?.manifestPermissions;
    const resolution = this.deps.policy.resolveCapability({
      pluginId,
      agentId,
      capability: "secret.read-own",
      ...(manifestPermissions !== undefined ? { manifestPermissions } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!resolution.allowed) {
      instrument.warn("plugin.secret.access_denied", "插件读取 Secret 被拒绝", {
        pluginId,
        secretName,
        deniedBy: resolution.deniedBy ?? "grant",
      });
      throw new SecretAccessError(`Secret 读取被拒绝（${resolution.deniedBy ?? "grant"} 层）`);
    }
    return this.deps.store.get(pluginId, secretName);
  }

  // ── private helpers ───────────────────────────────────────────

  private isDeclared(pluginId: string, secretName: string): boolean {
    const set = this.declared.get(pluginId);
    return set !== undefined && set.has(secretName);
  }

  private validateSecretName(secretName: string): void {
    if (typeof secretName !== "string" || secretName.length < 1 || secretName.length > 128) {
      throw new Error("Secret 名称不合法");
    }
    // Secret 名称不能包含会在日志里泄露值的分隔符
    if (secretName.includes("\0")) {
      throw new Error("Secret 名称包含非法字符");
    }
  }

  private newTrace(operationId: string): TraceContext {
    return { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
  }
}
