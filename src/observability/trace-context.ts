import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceContext } from "../contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 TraceManager（plans/phase-11.md §三.5 / §四）
//
// - AsyncLocalStorage 自动传播 trace，不要求每层手工传递全部 ID；
// - 一次用户 Turn 一个 traceId；模型/工具/回想/当前 Turn subagent 是子 span；
// - 独立后台任务创建新 trace 并用 linkedTraceIds 指向来源；
// - ALS 不跨进程：插件/worker 使用平台签发或绑定调用实例的 trace carrier（T8），
//   入口由平台重新盖章。
// ═══════════════════════════════════════════════════════════════

const storage = new AsyncLocalStorage<TraceContext>();

/** 当前执行上下文中的 TraceContext；无上下文时 undefined */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

export function newTraceId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * 在当前上下文中运行 callback，自动携带 trace。
 * 未提供 trace 时从外层继承（子 span）；无外层则新建根 trace。
 * 评审 P1-6：子 span 的 parentSpanId 必须是父级 spanId（原实现错误地
 * 复制了祖父级 parentSpanId，导致真实 Turn 产生的 trace 拼不成树）。
 */
export function runWithTrace<T>(input: { trace?: TraceContext; parentSpanId?: string }, callback: () => T): T {
  const parent = input.trace ?? storage.getStore();
  const trace: TraceContext = parent !== undefined
    ? {
        traceId: parent.traceId,
        spanId: newSpanId(),
        parentSpanId: parent.spanId,
        ...(parent.operationId !== undefined ? { operationId: parent.operationId } : {}),
        ...(parent.correlationId !== undefined ? { correlationId: parent.correlationId } : {}),
        ...(parent.linkedTraceIds !== undefined ? { linkedTraceIds: parent.linkedTraceIds } : {}),
      }
    : {
        traceId: newTraceId(),
        spanId: newSpanId(),
      };
  if (input.parentSpanId !== undefined) {
    trace.parentSpanId = input.parentSpanId;
  }
  return storage.run(trace, callback);
}

/** 为独立后台任务创建新根 trace，并保留对来源 trace 的链接 */
export function runAsBackground<T>(input: { linkedTraceIds?: readonly string[]; operationId?: string }, callback: () => T): T {
  const parent = storage.getStore();
  const trace: TraceContext = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    ...(parent !== undefined
      ? { linkedTraceIds: [parent.traceId, ...(parent.linkedTraceIds ?? [])].slice(0, 16) }
      : input.linkedTraceIds !== undefined
        ? { linkedTraceIds: [...input.linkedTraceIds].slice(0, 16) }
        : {}),
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
  };
  return storage.run(trace, callback);
}

/** 用给定 trace（如 IPC carrier 或平台重新盖章后的 trace）包裹执行 */
export function runWithCarrier<T>(carrier: TraceContext, callback: () => T): T {
  return storage.run(carrier, callback);
}

/**
 * 生成 bootId：进程启动一次；跨进程各自独立（Windows 多进程不共享 writer）。
 * 格式：<appVersion>-<epochMs>-<random>
 */
export function createBootId(appVersion: string): string {
  return `${appVersion}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
