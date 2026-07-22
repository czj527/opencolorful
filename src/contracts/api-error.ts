export type ApiErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "AUTHENTICATION_FAILED"
  | "SESSION_ERROR"
  | "INTERNAL_ERROR";

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export function createApiError(
  code: ApiErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ApiError {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, retryable, details };
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ApiError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.details === undefined ||
      (typeof candidate.details === "object" && candidate.details !== null))
  );
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : "未知内部错误";
  return createApiError("INTERNAL_ERROR", message);
}
