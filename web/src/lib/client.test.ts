import { describe, expect, it, vi, beforeEach } from "vitest";

import { ApiClient, ApiClientError } from "../lib/api-client.js";
import type { HealthResponse, SessionView } from "../lib/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient", () => {
  const client = new ApiClient("http://127.0.0.1:4310");

  it("sends GET request for health", async () => {
    const health: HealthResponse = { status: "ok", version: "0.1.0", pid: 1234, uptimeSeconds: 10 };
    mockFetch.mockResolvedValueOnce(jsonResponse(health));

    const result = await client.getHealth();
    expect(result).toEqual(health);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/health", expect.objectContaining({ method: "GET" }));
  });

  it("sends POST request with JSON body for createSession", async () => {
    const session: SessionView = {
      id: "test-id",
      title: "Test",
      sessionPath: "/tmp/test",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archived: false,
      provider: null,
      model: null,
      toolMode: "read-only",
      workspaceCwd: "/tmp",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
      messages: [],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(session, 201));

    const result = await client.createSession("Test", "/tmp");
    expect(result).toEqual(session);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Test", cwd: "/tmp" }),
      }),
    );
  });

  it("sends PUT request for updateSessionSettings", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "test" }));

    await client.updateSessionSettings("test-id", { toolMode: "all", workspaceCwd: "/home/user/project", workspaceConfirmed: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/api/sessions/test-id/settings",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sends POST for sendPrompt", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "accepted", sessionId: "s1", streamId: "st1" }, 202));

    const result = await client.sendPrompt("s1", "Hello");
    expect(result.status).toBe("accepted");
    expect(result.streamId).toBe("st1");
  });

  it("sends POST for abort", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "accepted" }));

    await client.abort("s1", "st1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/api/sessions/s1/abort",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends DELETE for deleteSession", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "s1", archived: true }));

    await client.deleteSession("s1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/api/sessions/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws ApiClientError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ code: "NOT_FOUND", message: "Session 不存在", retryable: false }, 404));

    await expect(client.getSession("bad-id")).rejects.toThrow(ApiClientError);
  });

  it("handles supervisor endpoints", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "stopped", supervisor: { pid: 1, port: 4311, version: "0.1.0", uptimeSeconds: 0 }, agentServer: { status: "stopped", pid: null, port: null, version: null } }));

    const status = await client.getSupervisorStatus();
    expect(status.agentServer.status).toBe("stopped");
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/supervisor/status", expect.objectContaining({ method: "GET" }));
  });

  it("handles provider endpoints", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const providers = await client.listProviders();
    expect(providers).toEqual([]);
  });

  it("handles model endpoints", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const models = await client.listModels();
    expect(models).toEqual([]);
  });

  it("handles compact endpoint", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "completed" }));

    const result = await client.compact("s1");
    expect(result.status).toBe("completed");
  });
});
