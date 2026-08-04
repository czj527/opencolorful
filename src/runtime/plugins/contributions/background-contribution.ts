import type { PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import type { TraceContext } from "../../../contracts/observability.js";
import { instrument } from "../../../observability/instrument.js";
import { isKnownCapability } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import { checkCapabilities, recordCapabilityDenied } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Background Contribution（plans/phase-12.md §8.6）
//
// - 后台任务必须声明并发、重试、幂等键和资源预算（manifest background
//   contribution 的 maxConcurrency/maxRetries/timeoutMs）；
// - 禁用/更新/崩溃必须终止后台任务：terminateAll 中止该插件全部 in-flight；
// - 执行统一经 RuntimeHost.invoke（contributionKind=background/hook），
//   自动产生 plugin.execution.* 生命周期；
// - before Hook 失败默认阻止其负责的变更（behavior=block）；after Hook
//   失败记录 degraded，不回滚已完成的不可补偿外部动作；
// - Hook 只能注册到平台冻结的时点，不能任意 monkey patch Agent Loop。
// ═══════════════════════════════════════════════════════════════

/** 平台冻结的 Hook 时点（插件不能注册任意时点）。 */
export const HOOK_POINTS = [
  "session.before-start",
  "session.after-start",
  "session.before-end",
  "session.after-end",
  "turn.before-start",
  "turn.after-end",
  "message.before-send",
  "message.after-send",
  "tool.before-call",
  "tool.after-call",
  "prompt.before-build",
  "prompt.after-build",
] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_CACHE_CAPACITY = 512;

export interface BackgroundSpec {
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly timeoutMs: number;
}

export interface HookBinding {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly point: string;
  readonly behavior: "block" | "observe";
}

export type BackgroundRunResult =
  | { readonly ok: true; readonly result: unknown; readonly attempt: number }
  | {
      readonly ok: false;
      readonly code: "not-registered" | "concurrency-limit" | "timeout" | "cancelled" | "failed" | "not-running" | "runtime-error";
      readonly message: string;
      readonly attempt: number;
      readonly reasonCode?: string;
    };

export type HookRunResult =
  | { readonly ok: true; readonly degraded: boolean; readonly results: readonly { pluginId: string; contributionId: string; ok: boolean }[] }
  | { readonly ok: false; readonly blocked: true; readonly reason: string; readonly pluginId: string; readonly contributionId: string };

export interface BackgroundServiceDeps {
  readonly registry: ContributionRegistry;
  readonly runtimeHost: RuntimeHost;
  readonly policy: EffectivePolicy;
  readonly now?: () => number;
}

export class BackgroundService {
  private readonly now: () => number;
  /** pluginId → in-flight controllers（禁用/更新/崩溃终止用） */
  private readonly inflightByPlugin = new Map<string, Set<AbortController>>();
  /** 当前并发计数（pluginId:contributionId → 活跃数） */
  private readonly activeCounters = new Map<string, number>();
  /** 幂等键 → 已完成结果（有界缓存） */
  private readonly completedByKey = new Map<string, unknown>();
  /** Hook 时点 → 绑定列表 */
  private readonly hooksByPoint = new Map<string, HookBinding[]>();

  constructor(private readonly deps: BackgroundServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 登记插件声明的 Hook（point 必须是平台冻结时点）。 */
  registerHooks(pluginId: string): HookBinding[] {
    const hooks: HookBinding[] = [];
    for (const contribution of this.deps.registry.listByKind(pluginId, "hook")) {
      hooks.push(this.toHookBinding(contribution));
    }
    for (const binding of hooks) {
      const list = this.hooksByPoint.get(binding.point) ?? [];
      if (!list.some((item) => item.pluginId === binding.pluginId && item.contributionId === binding.contributionId)) {
        list.push(binding);
        this.hooksByPoint.set(binding.point, list);
      }
    }
    return hooks;
  }

  /** 移除插件全部 Hook 登记（禁用/更新/卸载时调用）。 */
  clearHooks(pluginId: string): void {
    for (const [point, list] of this.hooksByPoint) {
      const filtered = list.filter((binding) => binding.pluginId !== pluginId);
      if (filtered.length === 0) {
        this.hooksByPoint.delete(point);
      } else {
        this.hooksByPoint.set(point, filtered);
      }
    }
  }

  listHooks(pluginId: string): HookBinding[] {
    const result: HookBinding[] = [];
    for (const list of this.hooksByPoint.values()) {
      for (const binding of list) {
        if (binding.pluginId === pluginId) {
          result.push(binding);
        }
      }
    }
    return result;
  }

  listHooksByPoint(point: string): HookBinding[] {
    return [...(this.hooksByPoint.get(point) ?? [])];
  }

  /** 禁用/更新/卸载/崩溃：终止该插件全部 in-flight 后台任务与 Hook 调用。 */
  terminateAll(pluginId: string, reasonCode: string): void {
    const controllers = this.inflightByPlugin.get(pluginId);
    if (controllers !== undefined) {
      for (const controller of controllers) {
        controller.abort(new BackgroundTerminationError(reasonCode));
      }
    }
  }

  /** 执行后台任务：并发/重试/幂等键/资源预算由声明决定。 */
  async run(input: {
    readonly pluginId: string;
    readonly contributionId: string;
    readonly params?: unknown;
    readonly idempotencyKey?: string;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly state?: ResolveState;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly trace?: TraceContext;
    readonly signal?: AbortSignal;
  }): Promise<BackgroundRunResult> {
    const { pluginId, contributionId } = input;
    const contribution = this.deps.registry.get(pluginId, contributionId);
    if (contribution === undefined || contribution.kind !== "background") {
      return { ok: false, code: "not-registered", message: "后台任务未登记", attempt: 0 };
    }

    if (input.idempotencyKey !== undefined) {
      const cached = this.completedByKey.get(`${pluginId}:${contributionId}:${input.idempotencyKey}`);
      if (cached !== undefined) {
        return { ok: true, result: cached, attempt: 0 };
      }
    }

    const spec = this.readSpec(contribution);
    const counterKey = `${pluginId}:${contributionId}`;
    const active = this.activeCounters.get(counterKey) ?? 0;
    if (active >= spec.maxConcurrency) {
      return { ok: false, code: "concurrency-limit", message: `后台任务并发达到上限（${spec.maxConcurrency}）`, attempt: 0 };
    }
    this.activeCounters.set(counterKey, active + 1);
    const controllers = this.inflightByPlugin.get(pluginId) ?? new Set<AbortController>();
    this.inflightByPlugin.set(pluginId, controllers);

    try {
      for (let attempt = 1; attempt <= spec.maxRetries + 1; attempt += 1) {
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(new BackgroundTimeoutError("timeout")), spec.timeoutMs);
        const onExternalAbort = (): void => controller.abort();
        if (input.signal?.aborted === true) {
          controller.abort();
        } else {
          input.signal?.addEventListener("abort", onExternalAbort, { once: true });
        }
        try {
          const result = await this.deps.runtimeHost.invoke({
            pluginId,
            contributionKind: "background",
            contributionId,
            method: contributionId,
            ...(input.params !== undefined ? { params: input.params } : {}),
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            ...(input.trace !== undefined ? { trace: input.trace } : {}),
            signal: controller.signal,
          });
          if (result.ok) {
            if (input.idempotencyKey !== undefined) {
              this.rememberCompleted(`${pluginId}:${contributionId}:${input.idempotencyKey}`, result.result);
            }
            return { ok: true, result: result.result, attempt };
          }
          if (controller.signal.aborted) {
            const reason = this.abortReason(controller);
            if (reason === "timeout") {
              return { ok: false, code: "timeout", message: "后台任务执行超时", attempt, reasonCode: "timeout" };
            }
            return { ok: false, code: "cancelled", message: reason, attempt, reasonCode: reason };
          }
          if (result.code === "cancelled") {
            return { ok: false, code: "cancelled", message: result.message, attempt, reasonCode: "cancelled" };
          }
          if (attempt <= spec.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          return {
            ok: false,
            code: result.code === "not-running" ? "not-running" : "failed",
            message: result.message.slice(0, 400),
            attempt,
            reasonCode: `retry-exhausted-${attempt}`,
          };
        } catch (error) {
          if (controller.signal.aborted) {
            const reason = this.abortReason(controller);
            if (reason === "timeout") {
              return { ok: false, code: "timeout", message: "后台任务执行超时", attempt, reasonCode: "timeout" };
            }
            return { ok: false, code: "cancelled", message: reason, attempt, reasonCode: reason };
          }
          if (attempt <= spec.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          return {
            ok: false,
            code: "failed",
            message: error instanceof Error ? error.message.slice(0, 400) : "后台任务执行失败",
            attempt,
            reasonCode: "runtime-error",
          };
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
          input.signal?.removeEventListener("abort", onExternalAbort);
        }
      }
      return { ok: false, code: "failed", message: "后台任务执行失败", attempt: spec.maxRetries + 1 };
    } finally {
      const remaining = (this.activeCounters.get(counterKey) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeCounters.delete(counterKey);
      } else {
        this.activeCounters.set(counterKey, remaining);
      }
      if (controllers.size === 0) {
        this.inflightByPlugin.delete(pluginId);
      }
    }
  }

  /**
   * 执行某时点上的 Hook 序列（全部已登记绑定）。
   * direction=before：behavior=block 的 Hook 失败 → 阻止变更（blocked）；
   * direction=after：Hook 失败 → 记录 degraded，不回滚不可补偿外部动作。
   */
  async runHook(input: {
    readonly point: string;
    readonly direction: "before" | "after";
    readonly params?: unknown;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly state?: ResolveState;
    readonly trace?: TraceContext;
  }): Promise<HookRunResult> {
    const bindings = this.hooksByPoint.get(input.point) ?? [];
    if (bindings.length === 0) {
      return { ok: true, degraded: false, results: [] };
    }

    let degraded = false;
    const results: Array<{ pluginId: string; contributionId: string; ok: boolean }> = [];
    for (const binding of bindings) {
      const contribution = this.deps.registry.get(binding.pluginId, binding.contributionId);
      if (contribution === undefined || contribution.kind !== "hook") {
        results.push({ pluginId: binding.pluginId, contributionId: binding.contributionId, ok: false });
        continue;
      }
      const manifestPermissions = this.deps.registry.getActive(binding.pluginId)?.manifestPermissions;
      const capabilities = contribution.requiredCapabilities.filter(
        (capability): capability is import("../../../contracts/plugin-protocol.js").CapabilityKind => isKnownCapability(capability),
      );
      if (input.agentId !== undefined && capabilities.length > 0) {
        const guard = checkCapabilities({
          policy: this.deps.policy,
          pluginId: binding.pluginId,
          agentId: input.agentId,
          capabilities,
          manifestPermissions,
          state: input.state,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
        if (!guard.allowed) {
          recordCapabilityDenied({
            eventName: "plugin.sandbox.denied",
            pluginId: binding.pluginId,
            contributionId: binding.contributionId,
            agentId: input.agentId,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            capability: guard.capability,
            deniedBy: guard.deniedBy,
            reason: guard.reason ?? "权限不足",
          });
          if (input.direction === "before" && binding.behavior === "block") {
            return { ok: false, blocked: true, reason: guard.reason ?? "权限不足", pluginId: binding.pluginId, contributionId: binding.contributionId };
          }
          degraded = true;
          results.push({ pluginId: binding.pluginId, contributionId: binding.contributionId, ok: false });
          continue;
        }
      }

      const result = await this.deps.runtimeHost.invoke({
        pluginId: binding.pluginId,
        contributionKind: "hook",
        contributionId: binding.contributionId,
        method: binding.contributionId,
        params: { direction: input.direction, point: input.point, ...(input.params !== undefined ? { payload: input.params } : {}) },
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.trace !== undefined ? { trace: input.trace } : {}),
      });
      if (result.ok) {
        results.push({ pluginId: binding.pluginId, contributionId: binding.contributionId, ok: true });
        continue;
      }
      if (input.direction === "before" && binding.behavior === "block") {
        return { ok: false, blocked: true, reason: result.message.slice(0, 200), pluginId: binding.pluginId, contributionId: binding.contributionId };
      }
      // after Hook 失败：记录 degraded，不回滚外部动作
      degraded = true;
      instrument.warn("plugin.hook.degraded", "Hook 执行失败（已记录 degraded）", {
        pluginId: binding.pluginId,
        point: input.point,
        direction: input.direction,
      });
      results.push({ pluginId: binding.pluginId, contributionId: binding.contributionId, ok: false });
    }
    return { ok: true, degraded, results };
  }

  // ── private helpers ───────────────────────────────────────────

  private readSpec(contribution: RegisteredContribution): BackgroundSpec {
    const spec = contribution.spec;
    return {
      maxConcurrency: isPositiveInt(spec["maxConcurrency"]) ? spec["maxConcurrency"] : DEFAULT_MAX_CONCURRENCY,
      maxRetries: isNonNegativeInt(spec["maxRetries"]) ? spec["maxRetries"] : DEFAULT_MAX_RETRIES,
      timeoutMs: isPositiveInt(spec["timeoutMs"]) ? spec["timeoutMs"] : DEFAULT_TIMEOUT_MS,
    };
  }

  private toHookBinding(contribution: RegisteredContribution): HookBinding {
    if (contribution.kind !== "hook") {
      throw new Error(`非 Hook contribution：${contribution.id}`);
    }
    const point = contribution.spec["point"];
    if (typeof point !== "string" || !(HOOK_POINTS as readonly string[]).includes(point)) {
      throw new Error(`插件 ${contribution.pluginId} 的 Hook 时点未在平台冻结清单中：${String(point)}`);
    }
    const behavior = contribution.spec["behavior"];
    return {
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      point,
      behavior: behavior === "observe" ? "observe" : "block",
    };
  }

  private rememberCompleted(key: string, result: unknown): void {
    if (this.completedByKey.size >= IDEMPOTENCY_CACHE_CAPACITY) {
      const oldest = this.completedByKey.keys().next().value;
      if (oldest !== undefined) {
        this.completedByKey.delete(oldest);
      }
    }
    this.completedByKey.set(key, result);
  }

  private backoff(attempt: number): Promise<void> {
    const delayMs = Math.min(50 * attempt, 500);
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private abortReason(controller: AbortController): string {
    const reason = controller.signal.reason;
    if (reason instanceof BackgroundTimeoutError) {
      return "timeout";
    }
    if (reason instanceof BackgroundTerminationError) {
      return reason.reasonCode;
    }
    if (reason instanceof Error) {
      return reason.message.slice(0, 200);
    }
    return "cancelled";
  }
}

class BackgroundTimeoutError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BackgroundTimeoutError";
  }
}

export class BackgroundTerminationError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "BackgroundTerminationError";
    this.reasonCode = reasonCode;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
