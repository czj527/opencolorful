import { describe, expect, it } from "vitest";

import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { TokuiProjector, TokuiStreamBuilder } from "../../src/ui-projection/tokui/project.js";
import {
  TokuiPolicy,
  TOKUI_MAX_BUFFER,
  TOKUI_MAX_CHUNK_LENGTH,
} from "../../src/ui-projection/tokui/policy.js";

describe("TokUI projection", () => {
  it("projects tool.started into valid TokUI chunk", () => {
    const projector = new TokuiProjector();
    const result = projector.project({
      protocolVersion: 1, eventId: "evt-1", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 1, timestamp: "2026-07-21T12:00:00.000Z",
      type: "tool.started",
      payload: { toolCallId: "t1", toolName: "search" },
    } as unknown as PlatformEventEnvelope);

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.format).toBe("tokui");
    const chunk = (result as { chunk: string }).chunk;
    expect(chunk).toContain("工具调用");
    expect(chunk).toContain("search");
  });

  it("projects error event into TokUI card with danger badge", () => {
    const projector = new TokuiProjector();
    const result = projector.project({
      protocolVersion: 1, eventId: "evt-2", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 2, timestamp: "2026-07-21T12:00:01.000Z",
      type: "error",
      payload: { code: "TEST", message: "测试错误", retryable: false },
    } as unknown as PlatformEventEnvelope);

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.format).toBe("tokui");
    const chunk2 = (result as { chunk: string }).chunk;
    expect(chunk2).toContain("t:danger");
    expect(chunk2).toContain("测试错误");
  });

  it("projects plans and escapes tool IDs in every update", () => {
    const projector = new TokuiProjector();
    const plan = projector.project({
      protocolVersion: 1, eventId: "plan", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 1, timestamp: new Date().toISOString(),
      type: "plan.updated", payload: { items: ["one", "two"] },
    } as unknown as PlatformEventEnvelope);
    const completed = projector.project({
      protocolVersion: 1, eventId: "tool", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 2, timestamp: new Date().toISOString(),
      type: "tool.completed", payload: { toolCallId: 'x"][script]', isError: false },
    } as unknown as PlatformEventEnvelope);

    expect(plan).not.toBeNull();
    expect((plan as { chunk: string }).chunk).toContain("[plan tt:");
    expect((completed as { chunk: string }).chunk).not.toContain('[script]');
  });
});

describe("TokUI security policy", () => {
  it("allows known components", () => {
    const policy = new TokuiPolicy();
    expect(policy.validateComponent("card")).toBe(true);
    expect(policy.validateComponent("badge")).toBe(true);
    expect(policy.validateComponent("desc")).toBe(true);
  });

  it("rejects unknown components", () => {
    const policy = new TokuiPolicy();
    expect(policy.validateComponent("html")).toBe(false);
    expect(policy.validateComponent("script")).toBe(false);
  });

  it("rejects forbidden attributes in chunks", () => {
    const policy = new TokuiPolicy();
    const result = policy.validateChunk('[div html:"<script>alert(1)</script>"]');
    expect(result.ok).toBe(false);
  });

  it("rejects raw HTML in chunks", () => {
    const policy = new TokuiPolicy();
    const result = policy.validateChunk("[card tt:Test]<img src=x onerror=alert(1)>[/card]");
    expect(result.ok).toBe(false);
  });

  it("rejects chunks exceeding max length", () => {
    const policy = new TokuiPolicy();
    const longChunk = "x".repeat(TOKUI_MAX_CHUNK_LENGTH + 1);
    const result = policy.validateChunk(longChunk);
    expect(result.ok).toBe(false);
  });

  it("rejects unregistered handlers", () => {
    const policy = new TokuiPolicy();
    expect(policy.validateHandler("action:submit")).toBe(true);
    expect(policy.validateHandler("action:delete-all")).toBe(false);
    expect(policy.validateHandler("eval:malicious")).toBe(false);
    expect(policy.validateChunk("[btn sub:action:delete-all]").ok).toBe(false);
    expect(policy.validateChunk('[btn on:"click:action:delete-all"]').ok).toBe(false);
  });

  it("allows explicitly registered handlers", () => {
    const policy = new TokuiPolicy(["action:save"]);
    const result = policy.validateChunk('[btn clk:action:save tt:"保存"]');
    expect(result.ok).toBe(true);
  });
});

describe("TokUI stream builder", () => {
  it("buffers and flushes events as chunks", () => {
    const builder = new TokuiStreamBuilder();
    builder.feed({
      protocolVersion: 1, eventId: "evt-1", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 1, timestamp: "2026-07-21T12:00:00.000Z",
      type: "tool.started",
      payload: { toolCallId: "t1", toolName: "s" },
    } as unknown as PlatformEventEnvelope);
    builder.feed({
      protocolVersion: 1, eventId: "evt-2", sessionId: "session-tokui",
      streamId: "stream-1", sequence: 2, timestamp: "2026-07-21T12:00:01.000Z",
      type: "tool.completed",
      payload: { toolCallId: "t1", isError: false },
    } as unknown as PlatformEventEnvelope);

    const flushed = builder.flush();
    expect(flushed.length).toBeGreaterThan(0);
    expect(flushed.join("")).toContain("工具调用");
    expect(flushed.join("")).toContain("status:done");
    expect(builder.size).toBe(0);
  });

  it("never buffers more than the configured total limit", () => {
    const builder = new TokuiStreamBuilder();
    for (let index = 0; index < 10_000; index += 1) {
      builder.feed({
        protocolVersion: 1, eventId: `evt-${index}`, sessionId: "session-tokui",
        streamId: "stream-1", sequence: index + 1, timestamp: new Date().toISOString(),
        type: "error", payload: { code: "TEST", message: "x".repeat(200), retryable: false },
      } as unknown as PlatformEventEnvelope);
    }
    expect(builder.size).toBeLessThanOrEqual(TOKUI_MAX_BUFFER);
  });
});
