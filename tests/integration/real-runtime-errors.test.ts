import { describe, expect, it } from "vitest";

import { mapProviderError } from "../../src/runtime/provider-errors.js";

describe("provider error mapping", () => {
  it("maps 401 to AUTHENTICATION_FAILED", () => {
    const error = mapProviderError(new Error("HTTP 401 Unauthorized"));
    expect(error.code).toBe("AUTHENTICATION_FAILED");
    expect(error.retryable).toBe(false);
  });

  it("maps 403 to AUTHENTICATION_FAILED", () => {
    const error = mapProviderError(new Error("403 Forbidden"));
    expect(error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("maps 429 to RATE_LIMITED (retryable)", () => {
    const error = mapProviderError(new Error("429 Too Many Requests"));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
  });

  it("maps rate limit messages to RATE_LIMITED", () => {
    const error = mapProviderError(new Error("rate limit exceeded"));
    expect(error.code).toBe("RATE_LIMITED");
  });

  it("maps 500 to PROVIDER_UNAVAILABLE (retryable)", () => {
    const error = mapProviderError(new Error("500 Internal Server Error"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it("maps timeout to PROVIDER_UNAVAILABLE (retryable)", () => {
    const error = mapProviderError(new Error("ETIMEDOUT"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it("maps connection refused to PROVIDER_UNAVAILABLE", () => {
    const error = mapProviderError(new Error("ECONNREFUSED"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("maps unknown errors to PROVIDER_ERROR", () => {
    const error = mapProviderError(new Error("something unexpected"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.retryable).toBe(false);
  });

  it("sanitizes URLs from error messages", () => {
    const error = mapProviderError(new Error("Failed to connect to https://api.openai.com/v1/chat"));
    expect(error.message).not.toContain("https://");
    expect(error.message).toContain("[URL]");
  });

  it("sanitizes Authorization headers and API keys from error messages", () => {
    const error = mapProviderError(new Error("Authorization Bearer sk-abc123 is invalid"));
    expect(error.message).not.toContain("sk-abc123");
  });

  it("does not leak a non-sk Bearer token", () => {
    const error = mapProviderError(new Error("Authorization: Bearer plain-secret-token"));
    expect(error.message).not.toContain("plain-secret-token");
  });

  it("handles non-Error objects", () => {
    const error = mapProviderError("plain string error");
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("未知 Provider 错误");
  });
});
