import type { ApiErrorCode } from "../contracts/api-error.js";
import { createApiError } from "../contracts/api-error.js";

export function mapProviderError(error: unknown): ReturnType<typeof createApiError> {
  const message = error instanceof Error ? error.message : "未知 Provider 错误";

  // 移除可能包含凭据的 URL 和 header
  const sanitized = message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/(?:Authorization|api[_-]?key)[:\s]+[^\s]+(\s+[^\s]+)?/gi, "[AUTH_HEADER]")
    .replace(/\bsk-[a-zA-Z0-9_-]{5,}\b/g, "[API_KEY]");

  // HTTP 401/403 → 认证失败
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("authentication")
  ) {
    return createApiError("AUTHENTICATION_FAILED" as ApiErrorCode, sanitized, false);
  }

  // HTTP 429 → 限流，可重试
  if (message.includes("429") || message.includes("rate") || message.includes("limit")) {
    return createApiError("RATE_LIMITED" as ApiErrorCode, sanitized, true);
  }

  // HTTP 5xx / 超时 → 临时故障，可重试
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT")
  ) {
    return createApiError("PROVIDER_UNAVAILABLE" as ApiErrorCode, sanitized, true);
  }

  // 其他错误
  return createApiError("PROVIDER_ERROR" as ApiErrorCode, sanitized, false);
}
