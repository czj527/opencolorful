import { OBSERVABILITY_ATTRIBUTE_LIMITS } from "../../contracts/observability.js";
import { isSensitiveKey, normalizeSafeObject, redactText } from "../../observability/safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：受限 client-events（plans/phase-11.md §10.3）
//
// - 只接受 client.unhandled_error / client.render.failed 两种内置 schema；
// - body ≤ 64KB、持久化 payload ≤ 32KB；JSON Content-Type；
// - Origin 必须是本机 UI（127.0.0.1/localhost，任意端口）；
// - 双层速率限制：每客户端 60/min、全局 1200/min（滑动窗口）；
// - 服务端忽略客户端提交的 eventId/actor/scope/trace/producer/level/
//   significance；message 经 redact 脱敏，attributes 经 normalizeSafeObject
//   （敏感键名剔除、深度/长度有界）。
// ═══════════════════════════════════════════════════════════════

export const CLIENT_EVENT_MAX_BODY_BYTES = 64 * 1024;
export const CLIENT_EVENT_MAX_PAYLOAD_BYTES = 32 * 1024;
export const CLIENT_EVENT_NAMES = ["client.unhandled_error", "client.render.failed"] as const;

const PER_CLIENT_LIMIT = 60;
const GLOBAL_LIMIT = 1200;
const WINDOW_MS = 60_000;

export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export interface ClientEventInput {
  readonly eventName: ClientEventName;
  readonly message: string;
  readonly attributes?: Record<string, unknown>;
}

export type ClientEventParseResult =
  | { ok: true; event: ClientEventInput }
  | { ok: false; status: number; reason: string };

/** 双层速率限制：每客户端 + 全局滑动窗口（内存态，进程重启后清零） */
export class ClientEventRateLimiter {
  private readonly perClient = new Map<string, number[]>();
  private readonly global: number[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly perClientLimit = PER_CLIENT_LIMIT,
    private readonly globalLimit = GLOBAL_LIMIT,
  ) {}

  allow(clientKey: string): { ok: boolean; retryAfterMs: number } {
    const now = this.now();
    const cutoff = now - WINDOW_MS;
    const clientWindow = (this.perClient.get(clientKey) ?? []).filter((t) => t > cutoff);
    if (clientWindow.length >= this.perClientLimit) {
      this.perClient.set(clientKey, clientWindow);
      return { ok: false, retryAfterMs: clientWindow[0]! - now + WINDOW_MS };
    }
    const globalWindow = this.global.filter((t) => t > cutoff);
    if (globalWindow.length >= this.globalLimit) {
      return { ok: false, retryAfterMs: globalWindow[0]! - now + WINDOW_MS };
    }
    clientWindow.push(now);
    globalWindow.push(now);
    this.perClient.set(clientKey, clientWindow);
    this.global.length = 0;
    this.global.push(...globalWindow);
    return { ok: true, retryAfterMs: 0 };
  }

  /** 清空（测试/窗口管理用） */
  reset(): void {
    this.perClient.clear();
    this.global.length = 0;
  }
}

/** 校验本机 UI Origin（127.0.0.1 / localhost，任意端口） */
export function isLocalUiOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** 深度 redact：对字符串值（含嵌套）逐一脱敏，键名敏感的直接剔除；
 *  plain URL 整体替换（计划 §10.3：不接收 URL query 原文） */
const PLAIN_URL_RE = /https?:\/\/[^\s"'<>]+/gi;

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).replace(PLAIN_URL_RE, "[URL]");
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      result[key] = redactDeep(item);
    }
    return result;
  }
  return value;
}

/** 解析并校验客户端上报（body 已按 raw 字节读取）；payload 二次脱敏 */
export function parseClientEvent(raw: unknown): ClientEventParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: "body 必须是 JSON 对象" };
  }
  const input = raw as Record<string, unknown>;
  const eventName = input["eventName"];
  if (typeof eventName !== "string" || !(CLIENT_EVENT_NAMES as readonly string[]).includes(eventName)) {
    return { ok: false, status: 400, reason: "未知事件名" };
  }
  const message = input["message"];
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, status: 400, reason: "message 必须是非空字符串" };
  }
  let attributes: Record<string, unknown> | undefined;
  if (input["attributes"] !== undefined) {
    if (typeof input["attributes"] !== "object" || input["attributes"] === null || Array.isArray(input["attributes"])) {
      return { ok: false, status: 400, reason: "attributes 必须是对象" };
    }
    const cleaned = normalizeSafeObject(redactDeep(input["attributes"]));
    if (typeof cleaned.value === "object" && cleaned.value !== null && !Array.isArray(cleaned.value)) {
      attributes = cleaned.value as Record<string, unknown>;
    }
  }
  return {
    ok: true,
    event: {
      eventName: eventName as ClientEventName,
      message: redactText(message).slice(0, OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength),
      ...(attributes !== undefined ? { attributes } : {}),
    },
  };
}
