import type {
  ActivityPayload,
  ActorRef,
  EventScope,
  ExecutorRef,
  ResourceRef,
  TraceContext,
} from "../contracts/observability.js";
import type { ActivityAcceptResult, ActivityRecordInput } from "./activity-recorder.js";
import { ObservabilityContext } from "./observability-context.js";
import { sanitizeError } from "./safe-value.js";
import { currentTrace, newSpanId, newTraceId, runWithTrace } from "./trace-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 Instrument：平台埋点门面（plans/phase-11.md §四）
//
// - 进程内唯一单例；ObservabilityContext 由进程启动点 init 注入，
//   未 init（工具进程/测试）时全部方法 no-op，领域模块无需判空；
// - 平台边界自动产生 started/terminal（lifecycle），领域模块只提交补充语义
//   （summaryCode/attributes/durationMs），不能重复记录同一 Activity；
// - 所有 attributes 由调用方保证不含密钥/正文（recorder 只做结构 normalize，
//   脱敏在 producer 侧：error 一律经 sanitizeError）。
// ═══════════════════════════════════════════════════════════════

export interface LifecycleOptions {
  readonly startEventName: string;
  readonly actor: ActorRef;
  readonly executor: ExecutorRef;
  readonly target?: ResourceRef;
  readonly scope?: EventScope;
  /** 跨终态保持操作身份（recorder 唯一终态校验依据） */
  readonly operationId: string;
  readonly trace?: TraceContext;
  /** started 事件的补充 payload（summaryCode 由平台生成） */
  readonly startPayload?: Omit<ActivityPayload, "summaryCode">;
  /** 终态状态 → 事件名映射；缺省用 startEventName */
  readonly terminals?: Partial<Record<"completed" | "failed" | "cancelled" | "interrupted" | "denied" | "degraded" | "deferred" | "skipped", string>>;
}

export interface LifecycleHandle {
  readonly operationId: string;
  readonly started: ActivityAcceptResult | undefined;
  complete(payload?: Omit<ActivityPayload, "summaryCode">): void;
  fail(error: Error | string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  cancel(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  interrupt(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  deny(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  degraded(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  deferred(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
  skipped(reason: string, payload?: Omit<ActivityPayload, "summaryCode">): void;
}

export type ActivityPatch = Omit<ActivityPayload, "summaryCode">;

class Instrument {
  private context: ObservabilityContext | undefined;

  /** 进程启动点注入（server/supervisor 各自 init 自己的 context） */
  init(context: ObservabilityContext): void {
    this.context = context;
  }

  /** 清空绑定（测试隔离/进程角色切换） */
  reset(): void {
    this.context = undefined;
  }

  isEnabled(): boolean {
    return this.context !== undefined;
  }

  /** 同步 flush 诊断日志（进程退出/崩溃路径） */
  flush(): void {
    this.context?.flush();
  }

  // ─── 基础透传（未 init 时 no-op / 独立兜底） ──────────────────

  activity(input: ActivityRecordInput): ActivityAcceptResult | undefined {
    return this.context?.activity.append(input);
  }

  trace(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.trace(eventName, message, attributes);
  }
  debug(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.debug(eventName, message, attributes);
  }
  info(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.info(eventName, message, attributes);
  }
  warn(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.warn(eventName, message, attributes);
  }
  error(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.error(eventName, message, attributes);
  }
  fatal(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.context?.logger.fatal(eventName, message, attributes);
  }

  runWithTrace<T>(input: { trace?: TraceContext; parentSpanId?: string }, callback: () => T): T {
    return this.context === undefined ? callback() : this.context.runWithTrace(input, callback);
  }

  /** 后台任务：新根 trace（不继承调用方 ALS），避免跨会话 trace 污染 */
  runAsBackground<T>(input: { linkedTraceIds?: readonly string[]; operationId?: string }, callback: () => T): T {
    return this.context === undefined ? callback() : this.context.runAsBackground(input, callback);
  }

  currentTrace(): TraceContext | undefined {
    return this.context?.currentTrace() ?? currentTrace();
  }

  /** 未 init 时也返回可用 id（业务逻辑不依赖可观测性） */
  newTraceId(): string {
    return this.context?.newTraceId() ?? newTraceId();
  }

  newSpanId(): string {
    return this.context?.newSpanId() ?? newSpanId();
  }

  // ─── lifecycle：started/terminal 平台自动产生 ─────────────────

  startLifecycle(options: LifecycleOptions): LifecycleHandle {
    const startedAt = Date.now();
    const started = this.activity({
      eventName: options.startEventName,
      status: "started",
      operationId: options.operationId,
      actor: options.actor,
      executor: options.executor,
      ...(options.target !== undefined ? { target: options.target } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.trace !== undefined ? { trace: options.trace } : {}),
      payload: {
        summaryCode: summaryCodeOf(options.startEventName),
        ...options.startPayload,
      },
    });
    const base = (status: "completed" | "failed" | "cancelled" | "interrupted" | "denied" | "degraded" | "deferred" | "skipped"): ActivityRecordInput => {
      const eventName = options.terminals?.[status] ?? options.startEventName;
      return {
        eventName,
        status,
        operationId: options.operationId,
        actor: options.actor,
        executor: options.executor,
        ...(options.target !== undefined ? { target: options.target } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
        payload: { summaryCode: summaryCodeOf(eventName), durationMs: Date.now() - startedAt },
      };
    };
    const terminal = (status: "completed" | "failed" | "cancelled" | "interrupted" | "denied" | "degraded" | "deferred" | "skipped") =>
      (patch?: ActivityPatch): void => {
        this.activity({
          ...base(status),
          payload: { ...base(status).payload, ...patch },
        });
      };
    return {
      operationId: options.operationId,
      started,
      complete: terminal("completed"),
      fail: (error, patch) => {
        const cleaned = sanitizeError(error);
        this.activity({
          ...base("failed"),
          payload: {
            ...base("failed").payload,
            ...patch,
            summaryCode: summaryCodeOf(options.terminals?.failed ?? options.startEventName),
            attributes: { message: cleaned.message },
          },
        });
      },
      cancel: (reason, patch) => {
        this.activity({
          ...base("cancelled"),
          payload: { ...base("cancelled").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
      interrupt: (reason, patch) => {
        this.activity({
          ...base("interrupted"),
          payload: { ...base("interrupted").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
      deny: (reason, patch) => {
        this.activity({
          ...base("denied"),
          payload: { ...base("denied").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
      degraded: (reason, patch) => {
        this.activity({
          ...base("degraded"),
          payload: { ...base("degraded").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
      deferred: (reason, patch) => {
        this.activity({
          ...base("deferred"),
          payload: { ...base("deferred").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
      skipped: (reason, patch) => {
        this.activity({
          ...base("skipped"),
          payload: { ...base("skipped").payload, ...patch, attributes: { reason: reason.slice(0, 200) } },
        });
      },
    };
  }

  // ─── 子系统便捷方法（事件名/summaryCode 由平台固定） ───────────

  private platformActor(): ActorRef {
    return { kind: "system", id: this.context?.getProducer().component ?? "platform" };
  }
  private platformExecutor(): ExecutorRef {
    return { kind: "service", id: this.context?.getProducer().component ?? "platform" };
  }
  private bootOperationId(): string {
    return `boot-${this.context?.getProducer().bootId ?? "no-context"}`;
  }
  /** boot 分两阶段（start/stop）与独立 crash 操作：唯一终态约束下各自成操作 */
  private bootStopOperationId(): string {
    return `${this.bootOperationId()}-stop`;
  }
  private bootCrashOperationId(): string {
    return `${this.bootOperationId()}-crash`;
  }

  systemStarting(patch?: ActivityPatch): void {
    this.activity({
      eventName: "system.starting",
      status: "started",
      operationId: this.bootOperationId(),
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "system_starting", ...patch },
    });
  }

  systemStarted(patch?: ActivityPatch): void {
    this.activity({
      eventName: "system.started",
      status: "completed",
      operationId: this.bootOperationId(),
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "system_started", ...patch },
    });
  }

  systemStopping(patch?: ActivityPatch): void {
    this.activity({
      eventName: "system.stopping",
      status: "started",
      operationId: this.bootStopOperationId(),
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "system_stopping", ...patch },
    });
  }

  systemStopped(patch?: ActivityPatch): void {
    this.activity({
      eventName: "system.stopped",
      status: "completed",
      operationId: this.bootStopOperationId(),
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "system_stopped", ...patch },
    });
  }

  systemCrashed(reason: Error | string, patch?: ActivityPatch): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "system.crashed",
      status: "failed",
      operationId: this.bootCrashOperationId(),
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "system_crashed", attributes: { message: cleaned.message }, ...patch },
    });
  }

  storageDatabaseOpened(patch?: ActivityPatch): void {
    this.activity({
      eventName: "storage.database.opened",
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "storage_database_opened", ...patch },
    });
  }

  storageMigrationCompleted(from: number, to: number): void {
    this.activity({
      eventName: "storage.migration.completed",
      status: "completed",
      operationId: `migration-${from}-${to}`,
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "storage_migration_completed", attributes: { from, to } },
    });
  }

  storageMigrationFailed(reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "storage.migration.failed",
      status: "failed",
      operationId: `migration-${this.context?.getProducer().bootId ?? "no-context"}`,
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      payload: { summaryCode: "storage_migration_failed", attributes: { message: cleaned.message } },
    });
  }

  agentMigrationCompleted(agentId: string, patch?: ActivityPatch): void {
    this.activity({
      eventName: "agent.migration.completed",
      status: "completed",
      operationId: `agent-migrate-${agentId}`,
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      scope: { ownerAgentId: agentId },
      payload: { summaryCode: "agent_migration_completed", ...patch },
    });
  }

  agentMigrationFailed(agentId: string, reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "agent.migration.failed",
      status: "failed",
      operationId: `agent-migrate-${agentId}`,
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      scope: { ownerAgentId: agentId },
      payload: { summaryCode: "agent_migration_failed", attributes: { message: cleaned.message } },
    });
  }

  sessionCreated(sessionId: string, agentId?: string): void {
    this.activity({
      eventName: "session.created",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      target: { kind: "session", id: sessionId },
      ...(agentId !== undefined ? { scope: { ownerAgentId: agentId, sessionId } } : { scope: { sessionId } }),
      payload: { summaryCode: "session_created" },
    });
  }

  sessionOpened(sessionId: string, agentId?: string): void {
    this.activity({
      eventName: "session.opened",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      target: { kind: "session", id: sessionId },
      ...(agentId !== undefined ? { scope: { ownerAgentId: agentId, sessionId } } : { scope: { sessionId } }),
      payload: { summaryCode: "session_opened" },
    });
  }

  sessionArchived(sessionId: string, agentId?: string): void {
    this.activity({
      eventName: "session.archived",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      target: { kind: "session", id: sessionId },
      ...(agentId !== undefined ? { scope: { ownerAgentId: agentId, sessionId } } : { scope: { sessionId } }),
      payload: { summaryCode: "session_archived" },
    });
  }

  providerConfigured(providerId: string): void {
    this.activity({
      eventName: "provider.configured",
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      target: { kind: "provider", id: providerId },
      payload: { summaryCode: "provider_configured" },
    });
  }

  providerCredentialChanged(providerId: string): void {
    this.activity({
      eventName: "provider.credential.changed",
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      target: { kind: "provider", id: providerId },
      payload: { summaryCode: "provider_credential_changed" },
    });
  }

  providerDegraded(providerId: string, reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "provider.degraded",
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      target: { kind: "provider", id: providerId },
      payload: { summaryCode: "provider_degraded", attributes: { message: cleaned.message } },
    });
  }

  providerRecovered(providerId: string): void {
    this.activity({
      eventName: "provider.recovered",
      actor: this.platformActor(),
      executor: this.platformExecutor(),
      target: { kind: "provider", id: providerId },
      payload: { summaryCode: "provider_recovered" },
    });
  }

  apiRequestFailed(method: string, path: string, status: number, reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "api.request.failed",
      status: "failed",
      operationId: `api-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      payload: {
        summaryCode: "api_request_failed",
        attributes: { method: method.slice(0, 16), path: path.slice(0, 200), status, message: cleaned.message },
      },
    });
  }

  apiValidationFailed(method: string, path: string, reason: string): void {
    this.activity({
      eventName: "api.validation.failed",
      status: "denied",
      operationId: `api-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      payload: {
        summaryCode: "api_validation_failed",
        attributes: { method: method.slice(0, 16), path: path.slice(0, 200), reason: reason.slice(0, 200) },
      },
    });
  }

  sseConnected(sessionId: string): void {
    this.activity({
      eventName: "sse.connected",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      scope: { sessionId },
      payload: { summaryCode: "sse_connected" },
    });
  }

  sseDisconnected(sessionId: string): void {
    this.activity({
      eventName: "sse.disconnected",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      scope: { sessionId },
      payload: { summaryCode: "sse_disconnected" },
    });
  }

  wsConnected(clientId: string): void {
    this.activity({
      eventName: "ws.connected",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "ws_connected", attributes: { clientId } },
    });
  }

  wsDisconnected(clientId: string): void {
    this.activity({
      eventName: "ws.disconnected",
      actor: { kind: "user", id: "web" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "ws_disconnected", attributes: { clientId } },
    });
  }

  supervisorServerStarted(patch?: ActivityPatch): void {
    this.activity({
      eventName: "supervisor.server.started",
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_server_started", ...patch },
    });
  }

  supervisorServerStopped(patch?: ActivityPatch): void {
    this.activity({
      eventName: "supervisor.server.stopped",
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_server_stopped", ...patch },
    });
  }

  supervisorServerRestarted(patch?: ActivityPatch): void {
    this.activity({
      eventName: "supervisor.server.restarted",
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_server_restarted", ...patch },
    });
  }

  supervisorServerCrashed(reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "supervisor.server.crashed",
      status: "failed",
      operationId: `supervisor-crash-${Date.now()}`,
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_server_crashed", attributes: { message: cleaned.message } },
    });
  }

  healthDegraded(reason: Error | string): void {
    const cleaned = sanitizeError(reason);
    this.activity({
      eventName: "supervisor.health.degraded",
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_health_degraded", attributes: { message: cleaned.message } },
    });
  }

  healthRecovered(patch?: ActivityPatch): void {
    this.activity({
      eventName: "supervisor.health.recovered",
      actor: { kind: "supervisor", id: "supervisor" },
      executor: this.platformExecutor(),
      payload: { summaryCode: "supervisor_health_recovered", ...patch },
    });
  }
}

/** 进程内唯一埋点门面 */
export const instrument = new Instrument();

function summaryCodeOf(eventName: string): string {
  return eventName.replace(/\./g, "_");
}
