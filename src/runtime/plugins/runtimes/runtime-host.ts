import crypto from "node:crypto";

import type { RuntimePaths } from "../../../config/paths.js";
import type {
  ActorRef,
  EventScope,
  ExecutorRef,
  ResourceRef,
  TraceContext,
} from "../../../contracts/observability.js";
import type { ManifestRuntime, PluginExecutionSnapshot, PluginIpcCarrier, PluginRuntimeKind } from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import { sanitizeError } from "../../../observability/safe-value.js";
import { pluginVersionDir } from "../paths.js";
import type { PluginRegistry } from "../registry/plugin-registry.js";
import { readManifestFile } from "../sources/source-adapter.js";
import type { HostBroker, HostIdentity, HostRejectCode } from "../grants/host-broker.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import { CarrierRegistry } from "./carrier-registry.js";
import { JSON_RPC_ERROR_CODES, RpcRequestError, type JsonRpcWorkerRequest } from "./json-rpc.js";
import { StreamCapture } from "./stream-capture.js";
import { BundleRuntime } from "./bundle-runtime.js";
import { McpRuntime } from "./mcp-runtime.js";
import { NodeRuntime } from "./node-runtime.js";
import { PythonRuntime } from "./python-runtime.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Runtime Host（plans/phase-12.md §9 / §17.6）
//
// - 统一 PluginRuntime 接口：bundle（无子进程）/ mcp / node-process /
//   python-process 四类运行形态；
// - 实例生命周期：start/stop、崩溃检测、restart budget（默认 3 次/10 分钟，
//   超限 degraded 停止）、safe shutdown、update handoff；
// - 重启必须创建新 runtimeInstanceId，并以 relatedResources 关联旧实例；
// - 执行生命周期（plugin.execution.*）用 instrument.startLifecycle：
//   started → completed/failed/cancelled/timed_out/interrupted；
//   payload 只含 contributionKind/id/pluginId/version/duration/attempt/
//   status/errorCode 安全摘要（worker 回传的权威字段一律不可信，Host 重新盖章）；
// - 进程生命周期（plugin.process.*）自动记录，崩溃不影响 Server 与其他插件；
// - 取消 reasonCode 稳定：plugin_disabled / plugin_updated / plugin_uninstalled，
//   不伪装成用户 Abort。
// ═══════════════════════════════════════════════════════════════

export type RuntimeStatus = "starting" | "running" | "stopped" | "crashed" | "degraded";

export interface RuntimeInvokeInput {
  readonly operationId: string;
  readonly method: string;
  readonly params?: unknown;
  /** 平台签发的一次性 carrier（绑定 pluginId+runtimeInstanceId+operationId） */
  readonly carrier: PluginIpcCarrier;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type RuntimeInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly data?: unknown };

/** 四类 Runtime 统一接口（bundle 无子进程，其余进程运行时） */
export interface PluginRuntime {
  readonly kind: PluginRuntimeKind;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  readonly state: RuntimeStatus;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  invoke(input: RuntimeInvokeInput): Promise<RuntimeInvokeResult>;
  /** 向 worker 发送取消通知（进程运行时）；bundle 无操作。 */
  cancel(operationId: string, reason: string): void;
  isHealthy(): boolean;
}

export interface RuntimeInstance {
  readonly runtimeInstanceId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly kind: PluginRuntimeKind;
  readonly runtime: PluginRuntime;
  status: RuntimeStatus;
  /** 第几次启动（1-based；重启后递增） */
  readonly attempt: number;
  readonly startedAt: number;
  /** 重启时关联的旧实例 id */
  readonly linkedFrom?: string;
  lastError?: string;
  /** 崩溃时间戳（崩溃判定标记；避免对 status 的 TS 窄化依赖） */
  crashedAt?: number;
  /** in-flight 执行：operationId → 取消原因 + 触发执行的冻结快照/授权状态（P0-2/P1-1：worker 嵌套 Host 请求复用） */
  readonly operations: Map<string, { controller: AbortController; reasonCode: string; snapshot?: PluginExecutionSnapshot; state?: ResolveState }>;
}

export type PluginCancelReasonCode =
  | "plugin_disabled"
  | "plugin_updated"
  | "plugin_uninstalled"
  | "user-abort"
  | "runtime-crashed"
  | "shutdown"
  | "timeout";

export const DEFAULT_CANCEL_REASON_CODES: Record<"disabled" | "updated" | "uninstalled", PluginCancelReasonCode> = {
  disabled: "plugin_disabled",
  updated: "plugin_updated",
  uninstalled: "plugin_uninstalled",
} as const;

export const DEFAULT_RESTART_BUDGET = { maxCrashes: 3, windowMs: 10 * 60 * 1_000 } as const;

export interface RestartBudgetOptions {
  readonly maxCrashes?: number;
  readonly windowMs?: number;
}

export interface ProcessRuntimeDeps {
  readonly nodePath: string;
  readonly pythonInterpreter?: string;
  readonly carriers: CarrierRegistry;
  /** 进程非预期退出时回调（崩溃检测入口） */
  readonly onExit: (info: { code: number | null; signal: string | null }) => void;
  /** stderr/stdout 输出 sink（经 StreamCapture 脱敏/折叠/限速） */
  readonly onOutput: (chunk: Buffer | string) => void;
  /**
   * worker 主动请求（带 id）处理入口：由 RuntimeHost 注入桥接
   * （校验 carrier → 身份 → HostBroker 白名单调用 → 结果回写）。
   */
  readonly onWorkerRequest?: (message: JsonRpcWorkerRequest) => unknown;
}

export interface RuntimeCreationContext {
  readonly pluginId: string;
  readonly version: string;
  readonly versionDir: string;
  readonly runtimeInstanceId: string;
  readonly kind: PluginRuntimeKind;
  readonly entry?: string;
}

export type RuntimeFactory = (ctx: RuntimeCreationContext, deps: ProcessRuntimeDeps) => PluginRuntime;

export interface RuntimeHostDeps {
  readonly paths: RuntimePaths;
  readonly registry: PluginRegistry;
  readonly broker: HostBroker;
  readonly carriers: CarrierRegistry;
  readonly nodePath?: string;
  readonly pythonInterpreter?: string;
  readonly budget?: RestartBudgetOptions;
  readonly runtimeFactory?: RuntimeFactory;
  readonly now?: () => number;
}

export interface RuntimeInvokeCall {
  readonly pluginId: string;
  /** 扩展点类型（tool/command/provider/route/hook/background/surface） */
  readonly contributionKind: string;
  readonly contributionId: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly trace?: TraceContext;
  /**
   * P0-2：调用方（ToolService）携带的 in-flight turn 冻结实例/版本。
   * 当前实例与快照不一致（重启/更新产生新 runtimeInstanceId）时 fail-closed
   * 拒绝——"in-flight turn 不能中途换工具实现"（phase-12.md §十一）。
   */
  readonly expectedRuntimeInstanceId?: string;
  readonly expectedPluginVersion?: string;
  /** P1-1：in-flight turn 冻结快照/授权状态（随 operation 绑定，worker 嵌套 Host 请求复用） */
  readonly snapshot?: PluginExecutionSnapshot;
  readonly state?: ResolveState;
}

export class PluginRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginRuntimeError";
  }
}

const EXECUTION_TERMINAL_EVENT = {
  completed: "plugin.execution.completed",
  failed: "plugin.execution.failed",
  cancelled: "plugin.execution.cancelled",
  timedOut: "plugin.execution.timed_out",
  interrupted: "plugin.execution.interrupted",
} as const;

export class RuntimeHost {
  private readonly nodePath: string;
  private readonly pythonInterpreter: string | undefined;
  private readonly budget: Required<RestartBudgetOptions>;
  private readonly now: () => number;
  private readonly factory: RuntimeFactory;
  private readonly instances = new Map<string, RuntimeInstance>();
  private readonly starting = new Map<string, Promise<RuntimeInstance>>();
  /** 每个插件的崩溃时间戳（restart budget 判定） */
  private readonly crashHistory = new Map<string, number[]>();

  constructor(private readonly deps: RuntimeHostDeps) {
    this.nodePath = deps.nodePath ?? process.execPath;
    this.pythonInterpreter = deps.pythonInterpreter;
    this.budget = {
      maxCrashes: deps.budget?.maxCrashes ?? DEFAULT_RESTART_BUDGET.maxCrashes,
      windowMs: deps.budget?.windowMs ?? DEFAULT_RESTART_BUDGET.windowMs,
    };
    this.now = deps.now ?? (() => Date.now());
    this.factory = deps.runtimeFactory ?? this.defaultFactory.bind(this);
  }

  // ── 查询 ─────────────────────────────────────────────────────

  getInstance(pluginId: string): RuntimeInstance | undefined {
    return this.instances.get(pluginId);
  }

  listInstances(): readonly RuntimeInstance[] {
    return [...this.instances.values()];
  }

  isHealthy(pluginId: string): boolean {
    const instance = this.instances.get(pluginId);
    if (instance === undefined) return false;
    return instance.status === "running" && instance.runtime.isHealthy();
  }

  getStatus(pluginId: string): RuntimeStatus | undefined {
    return this.instances.get(pluginId)?.status;
  }

  // ── 启动 / 停止 / 交接 ───────────────────────────────────────

  /** 启动插件运行实例；已运行则幂等返回。 */
  start(pluginId: string): Promise<RuntimeInstance> {
    const existing = this.instances.get(pluginId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const inflight = this.starting.get(pluginId);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.startInternal(pluginId);
    this.starting.set(pluginId, promise);
    promise
      .catch(() => {
        // 启动失败：允许下次重试
      })
      .finally(() => {
        this.starting.delete(pluginId);
      });
    return promise;
  }

  private async startInternal(pluginId: string): Promise<RuntimeInstance> {
    this.deps.carriers.sweepExpired();
    const active = this.deps.registry.getActive(pluginId);
    if (active === undefined) {
      throw new PluginRuntimeError(`插件未安装：${pluginId}`);
    }
    if (active.status === "disabled" || active.status === "removed") {
      throw new PluginRuntimeError(`插件 ${pluginId} 状态为 ${active.status}，无法启动`);
    }
    const versionDir = pluginVersionDir(this.deps.paths, pluginId, active.version);
    let manifest: { runtime?: ManifestRuntime } | null = null;
    try {
      manifest = readManifestFile(versionDir) as { runtime?: ManifestRuntime } | null;
    } catch {
      throw new PluginRuntimeError(`插件 ${pluginId}@${active.version} 缺少 manifest.json，无法启动`);
    }
    const runtimeKind = manifest?.runtime?.kind ?? "bundle";
    const entry = manifest?.runtime?.entry;
    const runtimeInstanceId = `runtime-${pluginId}-${crypto.randomUUID()}`;
    const instance = this.createInstance({
      pluginId,
      version: active.version,
      versionDir,
      runtimeInstanceId,
      kind: runtimeKind,
      ...(entry !== undefined ? { entry } : {}),
    });
    this.instances.set(pluginId, instance);
    try {
      this.emitProcessStarted(instance);
      this.deps.broker.registerRuntimeInstance({ pluginId, runtimeInstanceId });
      await instance.runtime.start();
      instance.status = "running";
      return instance;
    } catch (error) {
      const cleaned = sanitizeError(error);
      instance.lastError = cleaned.message.slice(0, 400);
      instance.status = "crashed";
      this.deps.broker.invalidateRuntimeInstance(runtimeInstanceId);
      this.emitProcessCrashed(instance, cleaned.message);
      // 握手期崩溃可能已触发 handleCrash→restartInstance 并替换 map；
      // 仅当 map 中仍为本实例时才删除，避免误删重启实例（其子进程仍在运行，成为孤儿）
      if (this.instances.get(pluginId) === instance) {
        this.instances.delete(pluginId);
      }
      throw new PluginRuntimeError(`插件 ${pluginId} 运行实例启动失败：${cleaned.message.slice(0, 300)}`);
    }
  }

  /** 停止插件运行实例（safe shutdown）。 */
  async stop(pluginId: string, reasonCode: PluginCancelReasonCode = "shutdown"): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (instance === undefined) {
      return;
    }
    await this.stopInstance(instance, reasonCode);
  }

  /** 停止全部实例（Server shutdown 路径）。 */
  async stopAll(reasonCode: PluginCancelReasonCode = "shutdown"): Promise<void> {
    const instances = [...this.instances.values()];
    await Promise.allSettled(instances.map((instance) => this.stopInstance(instance, reasonCode)));
  }

  /** 更新/禁用/卸载交接：停止旧实例（新 runtimeInstanceId 由下次 start 产生）。 */
  async handoff(pluginId: string, reasonCode: PluginCancelReasonCode): Promise<boolean> {
    const instance = this.instances.get(pluginId);
    if (instance === undefined) {
      return false;
    }
    await this.stopInstance(instance, reasonCode);
    return true;
  }

  // ── 执行调用（统一 instrument 生命周期）──────────────────────

  /** 调用运行实例的一个方法；自动记录 plugin.execution.* 生命周期。 */
  async invoke(input: RuntimeInvokeCall): Promise<RuntimeInvokeResult> {
    const instance = this.instances.get(input.pluginId);
    if (instance === undefined) {
      return { ok: false, code: "not-running", message: `插件 ${input.pluginId} 没有运行实例` };
    }
    if (instance.status !== "running") {
      return { ok: false, code: "not-running", message: `插件 ${input.pluginId} 运行实例状态为 ${instance.status}` };
    }
    // P0-2：快照冻结的实例/版本与当前实例不一致（turn 中途重启/更新）→ fail-closed，
    // 不允许旧 turn 在新实现上继续执行（phase-12.md §十一"不能中途换工具实现"）。
    // P1（第五轮）：拒绝必须留痕——plugin.execution.rejected 点事件携带旧快照
    // snapshotId/预期版本/当前版本/稳定 reasonCode（诊断更新竞态与旧 turn 调用的关键证据）
    if (input.expectedRuntimeInstanceId !== undefined && instance.runtimeInstanceId !== input.expectedRuntimeInstanceId) {
      this.recordExecutionRejected({
        input,
        instance,
        reasonCode: "runtime-instance-mismatch",
        message: `插件 ${input.pluginId} 运行实例已变更（快照 ${input.expectedRuntimeInstanceId} ≠ 当前 ${instance.runtimeInstanceId}）`,
      });
      return {
        ok: false,
        code: "runtime-instance-mismatch",
        message: `插件 ${input.pluginId} 运行实例已变更（快照 ${input.expectedRuntimeInstanceId} ≠ 当前 ${instance.runtimeInstanceId}），拒绝执行`,
      };
    }
    if (input.expectedPluginVersion !== undefined && instance.version !== input.expectedPluginVersion) {
      this.recordExecutionRejected({
        input,
        instance,
        reasonCode: "runtime-version-mismatch",
        message: `插件 ${input.pluginId} 版本已变更（快照 ${input.expectedPluginVersion} ≠ 当前 ${instance.version}）`,
      });
      return {
        ok: false,
        code: "runtime-version-mismatch",
        message: `插件 ${input.pluginId} 版本已变更（快照 ${input.expectedPluginVersion} ≠ 当前 ${instance.version}），拒绝执行`,
      };
    }

    const operationId = `exec-${crypto.randomUUID()}`;
    const controller = new AbortController();
    // P1-1：冻结快照/授权状态随 operation 绑定——worker 嵌套 Host 请求（secret/config/…）
    // 由 handleWorkerRequest 从 operation 取回并传给 broker.call，与工具入口同一冻结视图
    const operation = {
      controller,
      reasonCode: "user-abort" as PluginCancelReasonCode,
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
    };
    instance.operations.set(operationId, operation);

    const externalSignal = input.signal;
    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (externalSignal?.aborted === true) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const trace =
      input.trace ??
      instrument.currentTrace() ??
      { traceId: instrument.newTraceId(), spanId: instrument.newSpanId() };
    const actor: ActorRef = { kind: "plugin", id: input.pluginId };
    const executor: ExecutorRef = { kind: "worker", id: instance.runtimeInstanceId };
    const target: ResourceRef = { kind: "plugin", id: input.pluginId };
    const scope: EventScope = {
      pluginId: input.pluginId,
      ...(input.agentId !== undefined ? { ownerAgentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };

    const carrier = this.deps.carriers.issue({
      pluginId: instance.pluginId,
      runtimeInstanceId: instance.runtimeInstanceId,
      operationId,
      ...(trace.traceId !== undefined ? { traceId: trace.traceId } : {}),
      ...(trace.spanId !== undefined ? { spanId: trace.spanId } : {}),
      // Agent/Session 上下文随 carrier 签发：worker 回传请求 Host API 时
      // 由 handleWorkerRequest 提取并传入 broker.call（host-broker 上下文）
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });

    const lifecycle = this.startExecutionLifecycle({
      operationId,
      actor,
      executor,
      target,
      scope,
      trace,
      pluginId: instance.pluginId,
      version: instance.version,
      runtimeKind: instance.kind,
      contributionKind: input.contributionKind,
      contributionId: input.contributionId,
      attempt: instance.attempt,
      // §十一"每次工具调用记录实际插件版本和 snapshot id"：in-flight 冻结快照
      // 的 snapshotId 进执行生命周期 payload（工具调用可回放/诊断）
      ...(input.snapshot !== undefined ? { snapshotId: input.snapshot.snapshotId } : {}),
    });

    try {
      const result = await instance.runtime.invoke({
        operationId,
        method: input.method,
        ...(input.params !== undefined ? { params: input.params } : {}),
        carrier,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        signal: controller.signal,
      });
      // 崩溃（runtime-crashed）优先于一切终态：in-flight 调用按契约 interrupted
      const crashed = instance.crashedAt !== undefined || operation.reasonCode === "runtime-crashed";
      if (result.ok) {
        if (crashed) {
          lifecycle.interrupt("runtime-crashed");
        } else {
          lifecycle.complete();
        }
        return result;
      }
      if (result.code === "timeout") {
        lifecycle.timedOut(result.message);
        return result;
      }
      if (crashed) {
        lifecycle.interrupt("runtime-crashed");
        return result;
      }
      if (result.code === "cancelled") {
        lifecycle.cancel(operation.reasonCode);
        return result;
      }
      lifecycle.fail(result.message, result.code);
      return result;
    } catch (error) {
      const cleaned = sanitizeError(error);
      lifecycle.fail(cleaned.message, "runtime-error");
      return { ok: false, code: "runtime-error", message: cleaned.message.slice(0, 400) };
    } finally {
      instance.operations.delete(operationId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.deps.carriers.revokeOperation(instance.pluginId, instance.runtimeInstanceId, operationId);
    }
  }

  // ── 崩溃检测与重启 ───────────────────────────────────────────

  private handleProcessExit(instance: RuntimeInstance, info: { code: number | null; signal: string | null }): void {
    if (instance.status === "stopped" || instance.status === "degraded") {
      // 主动停止（stop/handoff）时进程正常退出 → process.exited 已由 stopInstance 发出
      return;
    }
    if (instance.crashedAt !== undefined) {
      // 已判定崩溃，避免重复处理
      return;
    }
    this.handleCrash(instance, info);
  }

  private handleCrash(instance: RuntimeInstance, info: { code: number | null; signal: string | null }): void {
    if (this.crashHistory.get(instance.pluginId) === undefined) {
      this.crashHistory.set(instance.pluginId, []);
    }
    const history = this.crashHistory.get(instance.pluginId) as number[];
    const now = this.now();
    history.push(now);
    const cutoff = now - this.budget.windowMs;
    while (history.length > 0 && (history[0] as number) < cutoff) {
      history.shift();
    }

    const crashedCode = info.code ?? (info.signal !== null ? `signal-${info.signal}` : "unknown");
    const reason = `进程非预期退出（code=${crashedCode}${info.signal !== null ? `, signal=${info.signal}` : ""}）`;
    instance.lastError = reason.slice(0, 400);
    instance.status = "crashed";
    instance.crashedAt = now;
    this.deps.broker.invalidateRuntimeInstance(instance.runtimeInstanceId);
    this.emitProcessCrashed(instance, reason);

    // 结束 in-flight 执行（interrupted，原因 runtime-crashed）
    this.cancelInFlight(instance, "runtime-crashed");

    if (history.length > this.budget.maxCrashes) {
      // 超限：degraded 停止，不再重启
      instance.status = "degraded";
      this.instances.delete(instance.pluginId);
      this.emitDegraded(instance, `崩溃次数超过 restart budget（${this.budget.maxCrashes} 次/${this.budget.windowMs}ms），已停止重启`);
      return;
    }

    // 预算内：重启（新 runtimeInstanceId）
    const newInstance = this.restartInstance(instance, reason);
    if (newInstance === undefined) {
      instance.status = "degraded";
      this.instances.delete(instance.pluginId);
      this.emitDegraded(instance, "重启失败，已停止");
      return;
    }
    this.instances.set(instance.pluginId, newInstance);
  }

  private restartInstance(old: RuntimeInstance, reason: string): RuntimeInstance | undefined {
    const runtimeInstanceId = `runtime-${old.pluginId}-${crypto.randomUUID()}`;
    const entry = this.readEntry(old.pluginId, old.version);
    const instance = this.createInstance({
      pluginId: old.pluginId,
      version: old.version,
      versionDir: pluginVersionDir(this.deps.paths, old.pluginId, old.version),
      runtimeInstanceId,
      kind: old.kind,
      ...(entry !== undefined ? { entry } : {}),
      attempt: old.attempt + 1,
      linkedFrom: old.runtimeInstanceId,
    });
    this.emitProcessRestarted(old, instance, reason);
    try {
      this.deps.broker.registerRuntimeInstance({ pluginId: old.pluginId, runtimeInstanceId });
      this.emitProcessStarted(instance);
      instance.runtime
        .start()
        .then(() => {
          instance.status = "running";
        })
        .catch((error: unknown) => {
          const cleaned = sanitizeError(error);
          instance.status = "crashed";
          this.deps.broker.invalidateRuntimeInstance(runtimeInstanceId);
          this.emitProcessCrashed(instance, cleaned.message);
          // 启动失败期间可能已被更新的实例替换（再次崩溃→restart 或新的 start）；
          // 仅当 map 中仍为本实例时才删除，避免误删替换实例
          if (this.instances.get(old.pluginId) === instance) {
            this.instances.delete(old.pluginId);
          }
          this.emitDegraded(instance, `重启后启动失败：${cleaned.message.slice(0, 200)}`);
        });
      return instance;
    } catch (error) {
      const cleaned = sanitizeError(error);
      this.deps.broker.invalidateRuntimeInstance(runtimeInstanceId);
      instance.status = "crashed";
      this.emitProcessCrashed(instance, cleaned.message);
      return undefined;
    }
  }

  private readEntry(pluginId: string, version: string): string | undefined {
    try {
      const manifest = readManifestFile(pluginVersionDir(this.deps.paths, pluginId, version)) as { runtime?: ManifestRuntime } | null;
      return manifest?.runtime?.entry;
    } catch {
      return undefined;
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private createInstance(ctx: {
    readonly pluginId: string;
    readonly version: string;
    readonly versionDir: string;
    readonly runtimeInstanceId: string;
    readonly kind: PluginRuntimeKind;
    readonly entry?: string;
    readonly attempt?: number;
    readonly linkedFrom?: string;
  }): RuntimeInstance {
    const streamCapture = new StreamCapture({
      pluginId: ctx.pluginId,
      runtimeInstanceId: ctx.runtimeInstanceId,
      stream: "stderr",
    });
    const instance: RuntimeInstance = {
      runtimeInstanceId: ctx.runtimeInstanceId,
      pluginId: ctx.pluginId,
      version: ctx.version,
      kind: ctx.kind,
      status: "starting",
      attempt: ctx.attempt ?? 1,
      startedAt: this.now(),
      ...(ctx.linkedFrom !== undefined ? { linkedFrom: ctx.linkedFrom } : {}),
      operations: new Map(),
      runtime: this.factory(
        {
          pluginId: ctx.pluginId,
          version: ctx.version,
          versionDir: ctx.versionDir,
          runtimeInstanceId: ctx.runtimeInstanceId,
          kind: ctx.kind,
          ...(ctx.entry !== undefined ? { entry: ctx.entry } : {}),
        },
        {
          nodePath: this.nodePath,
          ...(this.pythonInterpreter !== undefined ? { pythonInterpreter: this.pythonInterpreter } : {}),
          carriers: this.deps.carriers,
          onExit: (info) => this.handleProcessExit(instance, info),
          onOutput: (chunk) => streamCapture.write(chunk),
          onWorkerRequest: (message) => this.handleWorkerRequest(instance, message),
        },
      ),
    };
    return instance;
  }

  private defaultFactory(ctx: RuntimeCreationContext, deps: ProcessRuntimeDeps): PluginRuntime {
    switch (ctx.kind) {
      case "bundle":
        return new BundleRuntime({
          pluginId: ctx.pluginId,
          version: ctx.version,
          runtimeInstanceId: ctx.runtimeInstanceId,
        });
      case "node-process":
        return new NodeRuntime({
          pluginId: ctx.pluginId,
          version: ctx.version,
          runtimeInstanceId: ctx.runtimeInstanceId,
          versionDir: ctx.versionDir,
          entry: ctx.entry ?? "index.js",
          nodePath: deps.nodePath,
          carriers: deps.carriers,
          onExit: deps.onExit,
          onOutput: deps.onOutput,
          ...(deps.onWorkerRequest !== undefined ? { onWorkerRequest: deps.onWorkerRequest } : {}),
        });
      case "python-process":
        return new PythonRuntime({
          pluginId: ctx.pluginId,
          version: ctx.version,
          runtimeInstanceId: ctx.runtimeInstanceId,
          versionDir: ctx.versionDir,
          entry: ctx.entry ?? "main.py",
          ...(deps.pythonInterpreter !== undefined ? { interpreter: deps.pythonInterpreter } : {}),
          carriers: deps.carriers,
          onExit: deps.onExit,
          onOutput: deps.onOutput,
          ...(deps.onWorkerRequest !== undefined ? { onWorkerRequest: deps.onWorkerRequest } : {}),
        });
      case "mcp":
        return new McpRuntime({
          pluginId: ctx.pluginId,
          version: ctx.version,
          runtimeInstanceId: ctx.runtimeInstanceId,
          versionDir: ctx.versionDir,
          entry: ctx.entry ?? "server.js",
          nodePath: deps.nodePath,
          carriers: deps.carriers,
          onExit: deps.onExit,
          onOutput: deps.onOutput,
          ...(deps.onWorkerRequest !== undefined ? { onWorkerRequest: deps.onWorkerRequest } : {}),
        });
      default: {
        const kind: string = ctx.kind;
        throw new PluginRuntimeError(`不支持的运行形态：${kind}`);
      }
    }
  }

  private async stopInstance(instance: RuntimeInstance, reasonCode: PluginCancelReasonCode): Promise<void> {
    if (instance.status === "stopped") {
      return;
    }
    instance.status = "stopped";
    this.deps.broker.invalidateRuntimeInstance(instance.runtimeInstanceId);
    // 取消全部 in-flight 执行（cancelled，稳定 reasonCode，不伪装用户 Abort）
    this.cancelInFlight(instance, reasonCode);
    try {
      await instance.runtime.stop(reasonCode);
    } catch (error) {
      instance.lastError = sanitizeError(error).message.slice(0, 400);
    } finally {
      this.emitProcessExited(instance, reasonCode);
      this.instances.delete(instance.pluginId);
    }
  }

  private cancelInFlight(instance: RuntimeInstance, reasonCode: PluginCancelReasonCode): void {
    for (const operation of instance.operations.values()) {
      operation.reasonCode = reasonCode;
      operation.controller.abort();
    }
  }

  /**
   * worker 主动请求桥接：carrier 认证（一次性、未过期、属于该运行实例）→
   * HostBroker 白名单 API → 结果/错误回写 JSON-RPC 响应（经 json-rpc 层）。
   * 非法/无 carrier 请求抛 RpcRequestError 明确拒绝。
   */
  private handleWorkerRequest(instance: RuntimeInstance, message: JsonRpcWorkerRequest): unknown {
    const carrier = message.carrier;
    if (carrier === undefined) {
      throw new RpcRequestError(JSON_RPC_ERROR_CODES.invalidRequest, "worker 请求缺少平台签发的一次性 carrier，拒绝");
    }
    // 身份：carrier 必须属于接收该请求的运行实例（防跨实例/跨插件冒用）
    if (carrier.pluginId !== instance.pluginId || carrier.runtimeInstanceId !== instance.runtimeInstanceId) {
      throw new RpcRequestError(
        JSON_RPC_ERROR_CODES.invalidRequest,
        `worker 请求 carrier 不属于当前运行实例（${carrier.runtimeInstanceId}），拒绝`,
      );
    }
    // 单次消费：一次性、未过期、绑定 pluginId+runtimeInstanceId+operationId
    const consumed = this.deps.carriers.consume(carrier);
    if (!consumed.ok) {
      throw new RpcRequestError(JSON_RPC_ERROR_CODES.invalidRequest, `worker 请求 carrier 校验失败：${consumed.reason}`);
    }
    // HostBroker 白名单调用（内部再次校验身份 + 参数防伪造 + 能力校验）；
    // Agent/Session 上下文取自已消费校验的 carrier（随 token 绑定，worker 无法篡改）；
    // P1-1：snapshot/state 取自已消费校验的 operation（触发本执行的 in-flight 冻结
    // 授权/绑定视图）——嵌套 Host API（secret.read-own/config/…）与工具入口同一
    // 冻结权限，turn 中途的授权变更不影响本 turn（phase-12.md §十七.3 冻结语义）
    const operation = instance.operations.get(carrier.operationId);
    const result = this.deps.broker.call({
      identity: { pluginId: carrier.pluginId, runtimeInstanceId: carrier.runtimeInstanceId },
      apiName: message.method,
      ...(message.params !== undefined ? { args: message.params } : {}),
      ...(carrier.agentId !== undefined ? { agentId: carrier.agentId } : {}),
      ...(carrier.sessionId !== undefined ? { sessionId: carrier.sessionId } : {}),
      ...(operation?.snapshot !== undefined ? { snapshot: operation.snapshot } : {}),
      ...(operation?.state !== undefined ? { state: operation.state } : {}),
    });
    if (!result.ok) {
      throw new RpcRequestError(
        hostRejectToJsonRpcCode(result.code),
        `Host API ${message.method} 调用被拒绝（${result.code}）：${result.reason}`,
      );
    }
    return result.value;
  }

  /**
   * 执行被安全拒绝的证据（P1 第五轮）：旧快照调用新 Runtime（实例/版本不匹配）时，
   * 在 fail-closed 返回前记录 `plugin.execution.rejected` 点事件——携带旧快照
   * snapshotId、预期版本、当前版本与稳定 reasonCode，供诊断插件更新竞态/旧 turn
   * 调用（§十一"每次工具调用记录实际插件版本和 snapshot id"）。
   */
  private recordExecutionRejected(options: {
    readonly input: RuntimeInvokeCall;
    readonly instance: RuntimeInstance;
    readonly reasonCode: "runtime-instance-mismatch" | "runtime-version-mismatch";
    readonly message: string;
  }): void {
    const { input, instance, reasonCode, message } = options;
    const trace = input.trace ?? instrument.currentTrace() ?? {
      traceId: instrument.newTraceId(),
      spanId: instrument.newSpanId(),
    };
    instrument.activity({
      eventName: "plugin.execution.rejected",
      // point 事件（与 plugin.sandbox.denied 同语义）：不带 status，reasonCode 在 attributes
      operationId: `exec-rejected-${crypto.randomUUID()}`,
      actor: { kind: "plugin", id: input.pluginId },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: input.pluginId },
      scope: {
        pluginId: input.pluginId,
        ...(input.agentId !== undefined ? { ownerAgentId: input.agentId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      trace,
      payload: {
        summaryCode: "plugin_execution_rejected",
        attributes: {
          pluginId: input.pluginId,
          contributionKind: input.contributionKind,
          contributionId: input.contributionId,
          reasonCode,
          snapshotId: input.snapshot?.snapshotId ?? null,
          expectedRuntimeInstanceId: input.expectedRuntimeInstanceId ?? null,
          currentRuntimeInstanceId: instance.runtimeInstanceId,
          expectedVersion: input.expectedPluginVersion ?? null,
          currentVersion: instance.version,
          detail: message.slice(0, 300),
        },
      },
    });
  }

  // ── 可观测性（进程/执行生命周期）─────────────────────────────

  private emitProcessStarted(instance: RuntimeInstance): void {
    if (instance.kind === "bundle") return;
    instrument.activity({
      eventName: "plugin.process.started",
      status: "started",
      operationId: `proc-${instance.runtimeInstanceId}`,
      actor: { kind: "system", id: "runtime-host" },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: instance.pluginId },
      scope: { pluginId: instance.pluginId },
      payload: {
        summaryCode: "plugin_process_started",
        attributes: {
          pluginId: instance.pluginId,
          version: instance.version,
          runtimeKind: instance.kind,
          runtimeInstanceId: instance.runtimeInstanceId,
          attempt: instance.attempt,
        },
      },
    });
  }

  private emitProcessExited(instance: RuntimeInstance, reason: string): void {
    if (instance.kind === "bundle") return;
    instrument.activity({
      eventName: "plugin.process.exited",
      status: "completed",
      operationId: `proc-${instance.runtimeInstanceId}`,
      actor: { kind: "system", id: "runtime-host" },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: instance.pluginId },
      scope: { pluginId: instance.pluginId },
      payload: {
        summaryCode: "plugin_process_exited",
        attributes: {
          pluginId: instance.pluginId,
          version: instance.version,
          runtimeKind: instance.kind,
          runtimeInstanceId: instance.runtimeInstanceId,
          reason: reason.slice(0, 200),
        },
      },
    });
  }

  private emitProcessCrashed(instance: RuntimeInstance, reason: string): void {
    if (instance.kind === "bundle") return;
    instrument.activity({
      eventName: "plugin.process.crashed",
      status: "failed",
      operationId: `proc-${instance.runtimeInstanceId}`,
      actor: { kind: "system", id: "runtime-host" },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: instance.pluginId },
      scope: { pluginId: instance.pluginId },
      payload: {
        summaryCode: "plugin_process_crashed",
        attributes: {
          pluginId: instance.pluginId,
          version: instance.version,
          runtimeKind: instance.kind,
          runtimeInstanceId: instance.runtimeInstanceId,
          message: reason.slice(0, 300),
        },
      },
    });
  }

  private emitProcessRestarted(old: RuntimeInstance, next: RuntimeInstance, reason: string): void {
    if (old.kind === "bundle") return;
    instrument.activity({
      eventName: "plugin.process.restarted",
      actor: { kind: "system", id: "runtime-host" },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: old.pluginId },
      scope: { pluginId: old.pluginId },
      payload: {
        summaryCode: "plugin_process_restarted",
        relatedResources: [
          { kind: "plugin", id: old.runtimeInstanceId },
          { kind: "plugin", id: next.runtimeInstanceId },
        ],
        attributes: {
          pluginId: old.pluginId,
          version: old.version,
          runtimeKind: old.kind,
          previousRuntimeInstanceId: old.runtimeInstanceId,
          newRuntimeInstanceId: next.runtimeInstanceId,
          attempt: next.attempt,
          reason: reason.slice(0, 200),
        },
      },
    });
  }

  private emitDegraded(instance: RuntimeInstance, reason: string): void {
    instrument.activity({
      eventName: "plugin.degraded",
      actor: { kind: "system", id: "runtime-host" },
      executor: { kind: "service", id: "runtime-host" },
      target: { kind: "plugin", id: instance.pluginId },
      scope: { pluginId: instance.pluginId },
      payload: {
        summaryCode: "plugin_degraded",
        attributes: {
          pluginId: instance.pluginId,
          version: instance.version,
          runtimeKind: instance.kind,
          reason: reason.slice(0, 300),
        },
      },
    });
  }

  private startExecutionLifecycle(options: {
    readonly operationId: string;
    readonly actor: ActorRef;
    readonly executor: ExecutorRef;
    readonly target: ResourceRef;
    readonly scope: EventScope;
    readonly trace: TraceContext;
    readonly pluginId: string;
    readonly version: string;
    readonly runtimeKind: PluginRuntimeKind;
    readonly contributionKind: string;
    readonly contributionId: string;
    readonly attempt: number;
    /** §十一：in-flight 冻结快照 id（工具调用回放/诊断） */
    readonly snapshotId?: string;
  }): {
    complete(): void;
    fail(message: string, errorCode: string): void;
    cancel(reasonCode: string): void;
    timedOut(reason: string): void;
    interrupt(reasonCode: string): void;
  } {
    const startedAt = Date.now();
    const baseAttributes = {
      contributionKind: options.contributionKind,
      id: options.contributionId,
      pluginId: options.pluginId,
      version: options.version,
      runtimeKind: options.runtimeKind,
      ...(options.snapshotId !== undefined ? { snapshotId: options.snapshotId } : {}),
    };
    const handle = instrument.startLifecycle({
      startEventName: "plugin.execution.started",
      actor: options.actor,
      executor: options.executor,
      target: options.target,
      scope: options.scope,
      trace: options.trace,
      operationId: options.operationId,
      startPayload: {
        attempt: options.attempt,
        attributes: { ...baseAttributes, status: "started" },
      },
      terminals: {
        completed: EXECUTION_TERMINAL_EVENT.completed,
        failed: EXECUTION_TERMINAL_EVENT.failed,
        cancelled: EXECUTION_TERMINAL_EVENT.cancelled,
        interrupted: EXECUTION_TERMINAL_EVENT.interrupted,
      },
    });

    const emitTerminal = (
      eventName: string,
      status: "failed" | "cancelled" | "interrupted",
      extraAttributes: Record<string, unknown>,
      message?: string,
    ): void => {
      instrument.activity({
        eventName,
        status,
        operationId: options.operationId,
        actor: options.actor,
        executor: options.executor,
        target: options.target,
        scope: options.scope,
        trace: options.trace,
        payload: {
          summaryCode: eventName.replace(/\./g, "_"),
          durationMs: Date.now() - startedAt,
          attempt: options.attempt,
          attributes: {
            ...baseAttributes,
            status,
            ...extraAttributes,
            ...(message !== undefined ? { message: message.slice(0, 200) } : {}),
          },
        },
      });
    };

    return {
      complete: () => {
        handle.complete({
          attempt: options.attempt,
          attributes: { ...baseAttributes, status: "completed" },
        });
      },
      fail: (message, errorCode) => {
        emitTerminal(EXECUTION_TERMINAL_EVENT.failed, "failed", { errorCode }, message);
      },
      cancel: (reasonCode) => {
        emitTerminal(EXECUTION_TERMINAL_EVENT.cancelled, "cancelled", { reasonCode });
      },
      timedOut: (reason) => {
        emitTerminal(EXECUTION_TERMINAL_EVENT.timedOut, "failed", { errorCode: "timeout" }, reason);
      },
      interrupt: (reasonCode) => {
        emitTerminal(EXECUTION_TERMINAL_EVENT.interrupted, "interrupted", { reasonCode });
      },
    };
  }
}

/** HostBroker 拒绝原因 → JSON-RPC 错误码（能力被拒用实现定义的服务端错误区间 -32000..-32099）。 */
function hostRejectToJsonRpcCode(code: HostRejectCode): number {
  switch (code) {
    case "unknown-api":
      return JSON_RPC_ERROR_CODES.methodNotFound;
    case "forged-authority-fields":
      return JSON_RPC_ERROR_CODES.invalidParams;
    case "unauthorized-identity":
      return JSON_RPC_ERROR_CODES.invalidRequest;
    case "capability-denied":
      return -32003;
    case "handler-error":
      return JSON_RPC_ERROR_CODES.internalError;
  }
}
