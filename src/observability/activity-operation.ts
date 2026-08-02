import type {
  ActivityEnvelope,
  ActivityPayload,
  ActorRef,
  EventScope,
  ExecutorRef,
  ResourceRef,
  TraceContext,
} from "../contracts/observability.js";
import type { ActivityAcceptResult, ActivityRecorder } from "./activity-recorder.js";
import { currentTrace } from "./trace-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 ActivityOperation（plans/phase-11.md §四）
//
// - 自动测量 duration，防止 start/terminal 字段漂移；
// - 一个 operationId 只能有一个 started 与一个终态（recorder 侧幂等校验）；
// - 重复终态拒绝或幂等（recorder 返回 accepted-idempotent）。
// ═══════════════════════════════════════════════════════════════

export interface ActivityOperationOptions {
  readonly eventName: string;
  readonly actor: ActorRef;
  readonly executor: ExecutorRef;
  readonly target?: ResourceRef;
  readonly scope?: EventScope;
  readonly startedAt?: number;
  /** 跨调用保持操作身份（recorder 唯一终态校验依据） */
  readonly operationId: string;
}

export interface ActivityOperation {
  readonly operationId: string;
  readonly startedEventId: string;
  processing(payload?: Partial<ActivityPayload>): ActivityAcceptResult;
  complete(payload?: Partial<ActivityPayload>): ActivityAcceptResult;
  fail(error: Error | string, payload?: Partial<ActivityPayload>): ActivityAcceptResult;
  cancel(reason: string, payload?: Partial<ActivityPayload>): ActivityAcceptResult;
  defer(reason: string, payload?: Partial<ActivityPayload>): ActivityAcceptResult;
}

export function startOperation(
  recorder: ActivityRecorder,
  options: ActivityOperationOptions,
): { operation: ActivityOperation; started: ActivityAcceptResult } {
  const startedAt = options.startedAt ?? Date.now();
  const started = recorder.append({
    eventName: options.eventName,
    payload: { summaryCode: `${options.eventName.replace(/\./g, "_")}_started` },
    actor: options.actor,
    executor: options.executor,
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    operationId: options.operationId,
    status: "started",
  });
  const base = (): { eventName: string; actor: ActorRef; executor: ExecutorRef; target?: ResourceRef; scope?: EventScope; operationId: string } => ({
    eventName: options.eventName,
    actor: options.actor,
    executor: options.executor,
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    operationId: options.operationId,
  });
  const withDuration = (payload?: Partial<ActivityPayload>): ActivityPayload => ({
    summaryCode: "operation",
    ...payload,
    ...(payload?.durationMs === undefined ? { durationMs: Date.now() - startedAt } : {}),
  });
  const operation: ActivityOperation = {
    operationId: options.operationId,
    startedEventId: started.kind === "accepted" ? started.eventId : "",
    processing: (payload) => recorder.append({ ...base(), payload: withDuration(payload), status: "processing" }),
    complete: (payload) => recorder.append({ ...base(), payload: withDuration(payload), status: "completed" }),
    fail: (error, payload) => recorder.append({
      ...base(),
      payload: {
        ...withDuration(payload),
        summaryCode: "operation_failed",
        attributes: {
          ...(typeof error === "string" ? { message: error.slice(0, 2_000) } : { message: (error.message ?? String(error)).slice(0, 2_000) }),
        },
      },
      status: "failed",
    }),
    cancel: (reason, payload) => recorder.append({ ...base(), payload: { ...withDuration(payload), summaryCode: "operation_cancelled", attributes: { reason: reason.slice(0, 2_000) } }, status: "cancelled" }),
    defer: (reason, payload) => recorder.append({ ...base(), payload: { ...withDuration(payload), summaryCode: "operation_deferred", attributes: { reason: reason.slice(0, 2_000) } }, status: "deferred" }),
  };
  return { operation, started };
}

/** 便捷：当前 ALS trace 包装一次操作（自动继承 traceId） */
export function currentTraceOrEmpty(): TraceContext {
  return currentTrace() ?? { traceId: "no-trace", spanId: "no-span" };
}

/** 校验操作已正常 started（started 事件被拒绝时业务应提前失败） */
export function assertStarted(started: ActivityAcceptResult): void {
  if (started.kind === "rejected") {
    throw new Error(`活动开始事件被拒绝：${started.reason}`);
  }
}
