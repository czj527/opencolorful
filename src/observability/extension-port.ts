import type { ActivityPayload, TraceContext } from "../contracts/observability.js";
import { getCatalogEntry } from "./event-catalog.js";
import { normalizeSafeObject } from "./safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T8：ExtensionObservabilityPort（冻结端口，plans/phase-11.md §八）
//
// 未来插件/worker 只能拿到本端口：
// - 只暴露受限 diagnostic、受限 activity 与只读 trace carrier；
//   绝不暴露 Store、spool、AuditRecorder 或完整 Instrument；
// - 事件名必须已注册且 producerPolicy=extension-allowed（routine 固定），
//   audit 通道事件与平台专属事件一律拒绝；
// - 平台重新盖章 actor/executor/scope/trace/producer：扩展提交的
//   越权字段（actor/ownerAgent/trace/producer/level/significance/channel）
//   在输入类型上不存在，运行时传入的额外属性也不被读取；
// - IPC 返回的 trace carrier 必须由本端口签发、未过期且 pluginId 匹配，
//   否则事件回退到当前 ALS/no-trace；
// - 每插件滑动窗口速率限制（manifest.eventsPerMinute，默认 30/min）。
// ═══════════════════════════════════════════════════════════════

/** 只读、短期 trace carrier（平台签发；跨 IPC 传递，返回副本） */
export interface TraceCarrier {
  readonly traceId: string;
  readonly spanId: string;
  readonly operationId?: string;
  readonly pluginId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ExtensionManifest {
  readonly pluginId: string;
  /** diagnostic 事件名前缀（防命名冲突） */
  readonly eventNamespace: string;
  /** 每分钟 activity 事件上限（滑动窗口） */
  readonly eventsPerMinute?: number;
}

export interface ExtensionActivityInput {
  readonly eventName: string;
  readonly eventVersion?: number;
  readonly summaryCode: string;
  readonly attributes?: Record<string, unknown>;
  /** 平台先前发放的 trace carrier（IPC 返回时校验后由平台重新盖章） */
  readonly carrier?: TraceCarrier;
}

export type ExtensionActivityResult =
  | { kind: "accepted"; eventId: string }
  | { kind: "rejected"; reason: string };

export interface ExtensionObservabilityPort {
  /** 受限 diagnostic（脱敏/限长由平台 logger 保证；eventName 自动加 namespace 前缀） */
  diagnostic(
    level: "debug" | "info" | "warn" | "error",
    eventName: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): void;
  /** 受限 activity：extension-allowed routine 事件；平台重新盖章 */
  activity(input: ExtensionActivityInput): ExtensionActivityResult;
  /** 平台签发只读、短期 trace carrier（插件跨 IPC 回传时校验） */
  traceCarrier(): TraceCarrier | undefined;
  /** 关闭端口：后续调用全部拒绝/no-op */
  close(): void;
}

/** instrument 的最小可用子集（端口依赖收窄，便于测试注入） */
export interface ExtensionInstrumentLike {
  activity(input: {
    eventName: string;
    eventVersion?: number;
    payload: ActivityPayload;
    actor: { kind: "plugin"; id: string };
    executor: { kind: "plugin"; id: string };
    scope: { pluginId: string };
    trace?: TraceContext;
  }): { kind: string; eventId?: string } | undefined;
  debug(eventName: string, message: string, attributes?: Record<string, unknown>): void;
  info(eventName: string, message: string, attributes?: Record<string, unknown>): void;
  warn(eventName: string, message: string, attributes?: Record<string, unknown>): void;
  error(eventName: string, message: string, attributes?: Record<string, unknown>): void;
  currentTrace(): TraceContext | undefined;
  newTraceId(): string;
  newSpanId(): string;
}

const CARRIER_TTL_MS = 30_000;
const DEFAULT_EVENTS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

export function createExtensionObservabilityPort(options: {
  readonly manifest: ExtensionManifest;
  readonly instrument: ExtensionInstrumentLike;
  readonly now?: () => number;
}): ExtensionObservabilityPort {
  const now = options.now ?? (() => Date.now());
  const limit = Math.max(1, Math.floor(options.manifest.eventsPerMinute ?? DEFAULT_EVENTS_PER_MINUTE));
  let closed = false;
  const window: number[] = [];

  const rateLimited = (): boolean => {
    const cutoff = now() - WINDOW_MS;
    while (window.length > 0 && window[0]! < cutoff) window.shift();
    if (window.length >= limit) return true;
    window.push(now());
    return false;
  };

  const validateCarrier = (carrier: TraceCarrier | undefined): TraceContext | undefined => {
    if (carrier === undefined) return undefined;
    const current = now();
    if (carrier.pluginId !== options.manifest.pluginId) return undefined; // 非本插件签发
    if (current < carrier.issuedAt || current > carrier.expiresAt) return undefined; // 过期/未生效
    return {
      traceId: carrier.traceId,
      spanId: carrier.spanId,
      ...(carrier.operationId !== undefined ? { operationId: carrier.operationId } : {}),
    };
  };

  return {
    diagnostic(level, eventName, message, attributes) {
      if (closed) return;
      const prefixed = `${options.manifest.eventNamespace}.${eventName}`;
      if (level === "debug") options.instrument.debug(prefixed, message, attributes);
      else if (level === "warn") options.instrument.warn(prefixed, message, attributes);
      else if (level === "error") options.instrument.error(prefixed, message, attributes);
      else options.instrument.info(prefixed, message, attributes);
    },

    activity(input) {
      if (closed) return { kind: "rejected", reason: "端口已关闭" };
      const entry = getCatalogEntry(input.eventName, input.eventVersion);
      if (entry === undefined) return { kind: "rejected", reason: "事件未注册或版本不符" };
      if (entry.producerPolicy !== "extension-allowed") return { kind: "rejected", reason: "事件仅限平台产生" };
      if (entry.channel !== "activity") return { kind: "rejected", reason: "扩展不能直接产生 Audit" };
      if (rateLimited()) return { kind: "rejected", reason: "超过每插件速率限制" };
      // 平台重新盖章：扩展提交的 actor/scope/trace/producer/level/significance 一律忽略
      const carrierTrace = validateCarrier(input.carrier);
      // attributes 经平台 normalize（敏感键剔除、深度/长度有界）
      let payload: ActivityPayload = { summaryCode: input.summaryCode.slice(0, 96) };
      if (input.attributes !== undefined) {
        const cleaned = normalizeSafeObject(input.attributes);
        if (typeof cleaned.value === "object" && cleaned.value !== null && !Array.isArray(cleaned.value)) {
          payload = { ...payload, attributes: cleaned.value };
        }
      }
      const result = options.instrument.activity({
        eventName: entry.eventName,
        eventVersion: entry.eventVersion,
        payload,
        actor: { kind: "plugin", id: options.manifest.pluginId },
        executor: { kind: "plugin", id: options.manifest.pluginId },
        scope: { pluginId: options.manifest.pluginId },
        ...(carrierTrace !== undefined
          ? { trace: carrierTrace }
          : {}),
      });
      if (result === undefined) return { kind: "rejected", reason: "可观测性未初始化" };
      // spooled 也属 durable 成功（应急落盘，稍后导入）
      if (result.kind === "accepted" || result.kind === "spooled") {
        return { kind: "accepted", eventId: result.eventId ?? "" };
      }
      return { kind: "rejected", reason: "事件被拒绝" };
    },

    traceCarrier() {
      if (closed) return undefined;
      const trace = options.instrument.currentTrace();
      const current = now();
      return {
        traceId: trace?.traceId ?? options.instrument.newTraceId(),
        spanId: trace?.spanId ?? options.instrument.newSpanId(),
        ...(trace?.operationId !== undefined ? { operationId: trace.operationId } : {}),
        pluginId: options.manifest.pluginId,
        issuedAt: current,
        expiresAt: current + CARRIER_TTL_MS,
      };
    },

    close() {
      closed = true;
      window.length = 0;
    },
  };
}
