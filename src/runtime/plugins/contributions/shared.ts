import type {
  ActorRef,
  EventScope,
  ExecutorRef,
  ResourceRef,
  TraceContext,
} from "../../../contracts/observability.js";
import type {
  CapabilityKind,
  PluginExecutionSnapshot,
} from "../../../contracts/plugin-protocol.js";
import { assertDurableAudit, type AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Contribution 共享辅助（plans/phase-12.md §八 / §17.5）
//
// - capabilityGuard：contribution 调用前的权限交集检查（EffectivePolicy +
//   in-flight 快照冻结状态）；任一能力被拒绝即整体拒绝并返回拒绝层；
// - redactSensitive：脱敏工具——从对象中剥离明显敏感键（token/key/secret/
//   password/authorization/cookie 等），任何进入日志/错误消息的摘要都先脱敏；
// - byteSize：贡献输入/输出的 JSON 序列化大小上限判定。
// ═══════════════════════════════════════════════════════════════

const SENSITIVE_KEY_PATTERN =
  /(^|_)(secret|secrets|token|tokens|password|passwd|passphrase|authorization|auth|cookie|cookies|apikey|api_key|credential|credentials|privatekey|private_key|access_key|client_secret)(_|$)/i;

export interface CapabilityGuardResult {
  readonly allowed: boolean;
  /** 首个拒绝的能力 */
  readonly capability?: CapabilityKind;
  readonly deniedBy?: string;
  readonly reason?: string;
}

/**
 * 权限交集前置检查：requiredCapabilities 全部 allowed 才放行。
 * 传入 state（ExecutionSnapshot 冻结的授权/绑定状态）时，in-flight turn
 * 以快照状态为准；未传则读当前库。
 */
export function checkCapabilities(input: {
  readonly policy: EffectivePolicy;
  readonly pluginId: string;
  readonly agentId: string;
  readonly capabilities: readonly CapabilityKind[];
  /** exactOptionalPropertyTypes：显式允许 undefined（调用方总是传值） */
  readonly manifestPermissions: readonly { capability: string; reason?: string }[] | undefined;
  readonly state: ResolveState | undefined;
  readonly sessionId?: string;
}): CapabilityGuardResult {
  for (const capability of input.capabilities) {
    const resolution = input.policy.resolveCapability({
      pluginId: input.pluginId,
      agentId: input.agentId,
      capability,
      ...(input.manifestPermissions !== undefined ? { manifestPermissions: input.manifestPermissions } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!resolution.allowed) {
      return {
        allowed: false,
        capability,
        deniedBy: resolution.deniedBy ?? "grant",
        reason: resolution.reason,
      };
    }
  }
  return { allowed: true };
}

/**
 * 权限拒绝的统一 activity 记录。
 * 事件名必须已在事件目录注册：工具调用前置拒绝用 tool.call.denied；
 * 其余 contribution（command/route/provider/background/hook）用
 * plugin.sandbox.denied（"Sandbox/Host capability 拒绝"统一证据事件）。
 */
export function recordCapabilityDenied(input: {
  readonly eventName: "tool.call.denied" | "plugin.sandbox.denied";
  readonly pluginId: string;
  readonly contributionId: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly capability: CapabilityKind | undefined;
  readonly deniedBy: string | undefined;
  readonly reason: string;
}): void {
  instrument.activity({
    eventName: input.eventName,
    // tool.call.denied 是 terminal 事件（可带 denied）；plugin.sandbox.denied
    // 是 point 事件（不带 status，与 SandboxBridge 一致）
    ...(input.eventName === "tool.call.denied" ? { status: "denied" as const } : {}),
    actor: { kind: "plugin", id: input.pluginId },
    executor: { kind: "plugin", id: input.pluginId },
    scope: {
      pluginId: input.pluginId,
      ownerAgentId: input.agentId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    },
    payload: {
      summaryCode: input.eventName.replace(/\./g, "_"),
      attributes: {
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        ...(input.capability !== undefined ? { capability: input.capability } : {}),
        ...(input.deniedBy !== undefined ? { deniedBy: input.deniedBy } : {}),
        reason: input.reason.slice(0, 200),
      },
    },
  });
}

/** 递归脱敏：剥离明显敏感键（key 名命中的值整体替换为 ***），保持结构。 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "***" : redactSensitive(nested);
    }
    return result;
  }
  return value;
}

/** 序列化字节数（JSON 紧凑序列化）。 */
export function serializedBytes(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 快照校验：如果传入了 in-flight 快照，则当前调用必须仍在快照登记的
 * contribution 集合内（防止绑定/版本变更后旧 contribution 继续被调用）。
 */
export function assertContributionInSnapshot(input: {
  /** exactOptionalPropertyTypes：显式允许 undefined */
  readonly snapshot: PluginExecutionSnapshot | undefined;
  readonly pluginId: string;
  readonly contributionId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.snapshot === undefined) {
    return { ok: true };
  }
  if (input.snapshot.pluginId !== input.pluginId) {
    return { ok: false, reason: "调用插件与快照插件不一致" };
  }
  if (!input.snapshot.contributions.includes(input.contributionId)) {
    return { ok: false, reason: `contribution ${input.contributionId} 不在当前快照登记范围内（绑定或版本已变更）` };
  }
  return { ok: true };
}

/**
 * 严格审计三阶段生命周期（plans/phase-12.md §17.3）：
 * started（fail-closed，未接受立即抛错）→ 领域写入 + completed 同一事务
 * → 失败补 failed 终态。用于 Config 变更 / Secret 变更等高风险领域修改。
 *
 * 外部副作用（文件/Secret 等，不在 SQLite 事务内的修改）失败补偿：
 * 通过可选 rollback 把"写入已生效但审计事务失败"的副作用恢复到变更前
 * 状态（§17.3：文件、Secret 或外部进程操作使用审计先行、可验证补偿）。
 * 仅当 write 成功返回后才调用——write 自身抛错视为副作用未生效（依赖
 * 写入方失败原子性：先持久化后更新内存，如 FileSecretStore）。
 */
export interface StrictAuditLifecycleOptions {
  readonly audit: AuditRecorder;
  readonly trace: TraceContext;
  readonly actor: ActorRef;
  readonly executor: ExecutorRef;
  readonly target: ResourceRef;
  readonly scope: EventScope;
  readonly startEventName: string;
  readonly completedEventName: string;
  readonly failedEventName: string;
  readonly action: string;
  readonly beforeRevision: string;
  readonly afterRevision?: string;
  readonly changedFields: readonly string[];
  /**
   * 审计失败补偿（可选，best-effort）：领域写入已成功返回、但 completed
   * 审计被拒（或 SQLite 事务提交失败）导致操作整体失败时，把已生效的外部
   * 副作用恢复到变更前状态（如 Secret 变更写回旧值）。补偿失败只 warn，
   * 不掩盖原错误。
   */
  readonly rollback?: () => void;
}

export function runStrictAuditLifecycle<T>(options: StrictAuditLifecycleOptions, write: () => T): T {
  const { audit, trace, actor, executor, target, scope } = options;
  const basePayload = (decision: "deferred" | "allowed" | "denied") => ({
    action: options.action,
    decision,
    beforeRevision: options.beforeRevision,
    ...(options.afterRevision !== undefined ? { afterRevision: options.afterRevision } : {}),
    changedFields: [...options.changedFields],
  });
  assertDurableAudit(
    audit.appendStrict({
      eventName: options.startEventName,
      payload: basePayload("deferred"),
      actor,
      executor,
      target,
      scope,
      trace,
    }),
    `${options.startEventName} 审计(启动)`,
  );
  // 领域写入是否已成功返回：外部副作用可能已生效，审计事务失败时需要补偿
  let writeCommitted = false;
  try {
    const { result } = audit.runAuditedTransaction(
      {
        eventName: options.completedEventName,
        payload: basePayload("allowed"),
        actor,
        executor,
        target,
        scope,
        trace,
      },
      () => {
        const result = write();
        writeCommitted = true;
        return result;
      },
    );
    return result;
  } catch (error) {
    // 领域写入已生效但审计事务失败：先 best-effort 补偿外部副作用，
    // 再补 failed 终态；failed 也写不进去时保留原错误
    if (writeCommitted && options.rollback !== undefined) {
      try {
        options.rollback();
      } catch (rollbackError) {
        instrument.warn(
          "plugin.audit.rollback_failed",
          `${options.action} 审计失败，领域补偿未生效（数据可能停留在变更后状态）`,
          {
            action: options.action,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        );
      }
    }
    try {
      audit.appendStrict({
        eventName: options.failedEventName,
        payload: {
          ...basePayload("denied"),
          reasonCode: "write_failed",
        },
        actor,
        executor,
        target,
        scope,
        trace,
      });
    } catch {
      // failed 终态也写不进去时保留原错误（appendStrict 已 fail-closed）
    }
    throw error;
  }
}
