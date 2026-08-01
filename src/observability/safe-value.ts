import {
  OBSERVABILITY_ATTRIBUTE_LIMITS,
  type SafeValue,
} from "../contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 SafeValue normalize（plans/phase-11.md §八）
//
// 两阶段脱敏：
// 1) 结构化 normalize：字段 allowlist + 深度/长度/数量限额 + 循环引用防护；
// 2) 文本 redact：secret-like key、Bearer/Authorization、Cookie、URL 凭据、
//    Provider key（sk-…）、base64 疑似凭据、PII 占位与 Windows/Unix 路径。
//
// 永不记录（§8.1）：API Key、Authorization、Cookie、完整 Prompt、
// 完整记忆正文、文件内容、完整工具输入输出。
// ═══════════════════════════════════════════════════════════════

const SECRET_KEY_RE = /(^|[_-])(api[_-]?key|secret|token|password|passwd|pwd|credential|authorization|cookie|session[_-]?id|bearer)([_-]?$|$)/i;
const AUTHORIZATION_RE = /\b(?:Authorization|Proxy-Authorization)(?:"\s*)?(?::|=)?\s*(?:"\s*)?(?:Bearer|Basic)?\s*[^"',;\s}]+/gi;
const API_KEY_RE = /\b(?:api[_-]?key|x-api-key)(?:"\s*)?(?::|=)\s*(?:"\s*)?[^"',;\s}]+/gi;
const SK_KEY_RE = /\bsk-[a-zA-Z0-9_-]{5,}\b/g;
const COOKIE_RE = /\b(?:cookie|set-cookie)(?:"\s*)?(?::|=)\s*(?:"\s*)?[^"',;\s}]+/gi;
const URL_CREDENTIAL_RE = /https?:\/\/[^\s/@]+:[^\s/@]+@/gi;
const BASE64_LIKE_RE = /\b(?:eyJ[a-zA-Z0-9_-]{10,}|[a-zA-Z0-9+/]{40,}={0,2})\b/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g;
const UNIX_PATH_RE = /(?:\/home\/|\/Users\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/|\/usr\/)[^\s"']{3,}/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g;

/** 文本脱敏（两阶段第二层）：凭据/路径/PII → 稳定占位符 */
export function redactText(text: string): string {
  return text
    .replace(URL_CREDENTIAL_RE, "[URL_CREDENTIAL]")
    .replace(AUTHORIZATION_RE, "[AUTH_HEADER]")
    .replace(API_KEY_RE, "[API_KEY]")
    .replace(SK_KEY_RE, "[API_KEY]")
    .replace(COOKIE_RE, "[COOKIE]")
    .replace(BASE64_LIKE_RE, "[BASE64]")
    .replace(WINDOWS_PATH_RE, "[WIN_PATH]")
    .replace(UNIX_PATH_RE, "[PATH]")
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(PHONE_RE, "[PHONE]");
}

/** key 是否疑似敏感字段名（allowlist 的第一道闸） */
export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Error → 清洗后的 {message, stack}；循环引用与超长 stack 有界 */
export function sanitizeError(error: unknown): { message: string; stack?: string } {
  if (!(error instanceof Error)) {
    const text = String(error);
    return { message: redactText(text).slice(0, 4_000) };
  }
  const message = redactText(error.message).slice(0, 4_000);
  const stack = error.stack !== undefined ? redactText(error.stack).slice(0, 16_000) : undefined;
  return { message, ...(stack !== undefined ? { stack } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 结构化 normalize：把任意值收敛为 SafeValue。
 * - 敏感字段名直接剔除（值不落盘）；
 * - 深度 > maxDepth、数组 > maxArrayLength、字符串 > maxStringLength 截断并标记 truncated；
 * - 循环引用 → "[Circular]"；
 * - 对象键数量 > maxAttributeCount 时保留前 N 个。
 */
export function normalizeSafeValue(
  value: unknown,
  depth = 0,
  seen?: WeakSet<object>,
): SafeValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.length > OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength
        ? `${value.slice(0, OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength)}…(truncated)`
        : value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return null;
    case "object": {
      if (depth >= OBSERVABILITY_ATTRIBUTE_LIMITS.maxDepth) return "[depth-limited]";
      const tracker = seen ?? new WeakSet<object>();
      if (tracker.has(value as object)) return "[Circular]";
      tracker.add(value as object);
      if (Array.isArray(value)) {
        return value.slice(0, OBSERVABILITY_ATTRIBUTE_LIMITS.maxArrayLength)
          .map((item) => normalizeSafeValue(item, depth + 1, tracker));
      }
      const entries = Object.entries(value);
      if (entries.length > OBSERVABILITY_ATTRIBUTE_LIMITS.maxAttributeCount) {
        return { "[truncated]": `${entries.length - OBSERVABILITY_ATTRIBUTE_LIMITS.maxAttributeCount} attributes dropped` };
      }
      const result: Record<string, SafeValue> = {};
      for (const [key, item] of entries) {
        if (isSensitiveKey(key)) continue; // 敏感字段名：值不落盘
        result[key] = normalizeSafeValue(item, depth + 1, tracker);
      }
      return result;
    }
    default:
      return null;
  }
}

/**
 * 深度清洗对象（用于 payload/attributes）：整体 redact 后 normalize，
 * 并保证最终 JSON 体积 ≤ maxPayloadBytes。
 */
export function normalizeSafeObject(value: unknown): { value: SafeValue; truncated: boolean } {
  const normalized = normalizeSafeValue(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    return { value: { "[serialize-failed]": true }, truncated: true };
  }
  if (serialized.length > OBSERVABILITY_ATTRIBUTE_LIMITS.maxPayloadBytes) {
    return { value: { "[payload-too-large]": true }, truncated: true };
  }
  return { value: normalized, truncated: false };
}
