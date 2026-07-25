import { describe, expect, it } from "vitest";

import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { validateClientCommand } from "../../src/contracts/commands.js";
import {
  EventSequenceGuard,
  validatePlatformEvent,
} from "../../src/contracts/validation.js";

function messageEvent(overrides: Partial<PlatformEventEnvelope> = {}): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: "event-1",
    sessionId: "session-1",
    streamId: "stream-1",
    sequence: 1,
    timestamp: "2026-07-21T15:00:00.000Z",
    type: "message.delta",
    payload: { role: "assistant", delta: "你好" },
    ...overrides,
  } as PlatformEventEnvelope;
}

describe("platform events", () => {
  it("accepts a known event with a valid envelope", () => {
    const result = validatePlatformEvent(messageEvent());

    expect(result.ok).toBe(true);
  });

  it("rejects a session event without session identity", () => {
    const result = validatePlatformEvent(messageEvent({ sessionId: null }));

    expect(result.ok).toBe(false);
  });

  it("rejects invalid timestamps and non-positive sequences", () => {
    expect(validatePlatformEvent(messageEvent({ timestamp: "today" })).ok).toBe(false);
    expect(validatePlatformEvent(messageEvent({ sequence: 0 })).ok).toBe(false);
  });

  it("rejects unknown event types explicitly", () => {
    const result = validatePlatformEvent(messageEvent({ type: "custom.untrusted" } as never));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("未知事件类型");
    }
  });

  it("rejects an invalid payload for a known event", () => {
    const result = validatePlatformEvent(messageEvent({ payload: { delta: 42 } } as never));

    expect(result.ok).toBe(false);
  });

  it("accepts turn.completed carrying usage and context", () => {
    const result = validatePlatformEvent(
      messageEvent({
        type: "turn.completed",
        payload: {
          turnId: "turn-1",
          usage: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 100, totalTokens: 2440 },
          context: { tokens: 15000, contextWindow: 200000, percent: 7.5 },
        },
      } as never),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts turn.completed without usage and nullable context fields", () => {
    const bare = validatePlatformEvent(
      messageEvent({ type: "turn.completed", payload: { turnId: "turn-1" } } as never),
    );
    const nullContext = validatePlatformEvent(
      messageEvent({
        type: "turn.completed",
        payload: {
          turnId: "turn-1",
          context: { tokens: null, contextWindow: 200000, percent: null },
        },
      } as never),
    );

    expect(bare.ok).toBe(true);
    expect(nullContext.ok).toBe(true);
  });

  it("rejects malformed usage on turn.completed", () => {
    const negative = validatePlatformEvent(
      messageEvent({
        type: "turn.completed",
        payload: { turnId: "turn-1", usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
      } as never),
    );
    const missing = validatePlatformEvent(
      messageEvent({
        type: "turn.completed",
        payload: { turnId: "turn-1", usage: { input: 1 } },
      } as never),
    );

    expect(negative.ok).toBe(false);
    expect(missing.ok).toBe(false);
  });

  it("accepts session.compacting and session.compacted events", () => {
    const compacting = validatePlatformEvent(
      messageEvent({ type: "session.compacting", payload: { reason: "manual" } } as never),
    );
    const compacted = validatePlatformEvent(
      messageEvent({
        type: "session.compacted",
        payload: {
          reason: "manual",
          tokensBefore: 120000,
          tokensAfter: 30000,
          summary: "摘要",
          aborted: false,
        },
      } as never),
    );

    expect(compacting.ok).toBe(true);
    expect(compacted.ok).toBe(true);
  });
});

describe("event sequence", () => {
  it("accepts strictly increasing sequence numbers per stream", () => {
    const guard = new EventSequenceGuard();

    expect(guard.accept(messageEvent())).toBe(true);
    expect(guard.accept(messageEvent({ eventId: "event-2", sequence: 2 }))).toBe(true);
  });

  it("rejects duplicate, skipped, and non-starting sequences", () => {
    const duplicate = new EventSequenceGuard();
    expect(duplicate.accept(messageEvent())).toBe(true);
    expect(duplicate.accept(messageEvent({ eventId: "event-2" }))).toBe(false);

    const skipped = new EventSequenceGuard();
    expect(skipped.accept(messageEvent({ sequence: 2 }))).toBe(false);
  });
});

describe("client commands", () => {
  it("accepts abort, compact, subscribe, and resume commands", () => {
    const commands = [
      { protocolVersion: 1, requestId: "r1", type: "session.abort", sessionId: "session-1" },
      { protocolVersion: 1, requestId: "r2", type: "session.compact", sessionId: "session-1" },
      { protocolVersion: 1, requestId: "r3", type: "session.subscribe", sessionId: "session-1" },
      {
        protocolVersion: 1,
        requestId: "r4",
        type: "stream.resume",
        sessionId: "session-1",
        streamId: "stream-1",
        lastSequence: 3,
      },
    ];

    for (const command of commands) {
      expect(validateClientCommand(command).ok).toBe(true);
    }
  });

  it("rejects unknown commands and malformed resume positions", () => {
    expect(validateClientCommand({ protocolVersion: 1, requestId: "r", type: "other" }).ok).toBe(
      false,
    );
    expect(
      validateClientCommand({
        protocolVersion: 1,
        requestId: "r",
        type: "stream.resume",
        sessionId: "session-1",
        streamId: "stream-1",
        lastSequence: -1,
      }).ok,
    ).toBe(false);
  });
});
