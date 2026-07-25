import { describe, expect, it } from "vitest";

import { PlatformEventMapper } from "../../src/runtime/event-mapper.js";

describe("PlatformEventMapper turn usage and context", () => {
  const usage = { input: 1200, output: 340, cacheRead: 800, cacheWrite: 100, totalTokens: 2440 };
  const context = { tokens: 15000, contextWindow: 200000, percent: 7.5 };

  it("carries usage and context on turn.completed", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    mapper.map({ type: "turn_start" });
    const [event] = mapper.map({ type: "turn_end", usage, context });

    expect(event?.type).toBe("turn.completed");
    const payload = event?.payload as { turnId: string; usage?: unknown; context?: unknown };
    expect(payload.turnId).toMatch(/^turn-/);
    expect(payload.usage).toEqual(usage);
    expect(payload.context).toEqual(context);
  });

  it("omits usage and context when the turn ended without them", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    mapper.map({ type: "turn_start" });
    const [event] = mapper.map({ type: "turn_end" });

    const payload = event?.payload as { usage?: unknown; context?: unknown };
    expect(payload.usage).toBeUndefined();
    expect(payload.context).toBeUndefined();
  });

  it("keeps sequence strictly increasing across usage events", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [started] = mapper.map({ type: "turn_start" });
    const [completed] = mapper.map({ type: "turn_end", usage, context });

    expect(started?.sequence).toBe(1);
    expect(completed?.sequence).toBe(2);
  });
});

describe("PlatformEventMapper compaction events", () => {
  it("maps compaction_start to session.compacting", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({ type: "compaction_start", reason: "manual" });

    expect(event?.type).toBe("session.compacting");
    expect(event?.payload).toEqual({ reason: "manual" });
  });

  it("maps compaction_end with truncated and sanitized summary", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "compaction_end",
      reason: "manual",
      tokensBefore: 120000,
      estimatedTokensAfter: 30000,
      summary: `压缩摘要 Authorization: Bearer compaction-secret-token ${"x".repeat(1000)}`,
      aborted: false,
    });

    expect(event?.type).toBe("session.compacted");
    const payload = event?.payload as Record<string, unknown>;
    expect(payload.reason).toBe("manual");
    expect(payload.tokensBefore).toBe(120000);
    expect(payload.tokensAfter).toBe(30000);
    expect(payload.aborted).toBe(false);
    expect(payload.summary).not.toContain("compaction-secret-token");
    expect((payload.summary as string).length).toBeLessThanOrEqual(500);
  });

  it("keeps error information on aborted compaction without result", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "compaction_end",
      reason: "threshold",
      aborted: true,
      errorMessage: "压缩已中断",
    });

    const payload = event?.payload as Record<string, unknown>;
    expect(payload.aborted).toBe(true);
    expect(payload.errorMessage).toBe("压缩已中断");
    expect(payload.tokensBefore).toBeUndefined();
    expect(payload.summary).toBeUndefined();
  });
});

describe("PlatformEventMapper tool result safety", () => {
  it("redacts and bounds tool result payloads", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "tool_end",
      toolCallId: "tool-1",
      result: `Authorization: Bearer plain-secret-token ${"x".repeat(5000)}`,
      isError: false,
    });

    expect(event).toBeDefined();
    const result = (event?.payload as { result?: unknown }).result;
    expect(typeof result).toBe("string");
    expect(result).not.toContain("plain-secret-token");
    expect((result as string).length).toBeLessThanOrEqual(2000);
  });

  it("redacts credentials inside structured tool results", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "tool_end",
      toolCallId: "tool-2",
      result: { headers: { Authorization: "Bearer json-secret-token" } },
      isError: false,
    });

    const result = (event?.payload as { result?: unknown }).result;
    expect(result).not.toContain("json-secret-token");
  });
});
