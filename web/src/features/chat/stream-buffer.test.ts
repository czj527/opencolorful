import { describe, expect, it, vi } from "vitest";

import { StreamBuffer } from "./stream-buffer.js";
import type { PlatformEventEnvelope } from "../../lib/types.js";

function makeEvent(type: string, streamId = "st1", sequence = 1): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `evt-${streamId}-${sequence}`,
    sessionId: "s1",
    streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload: { content: `${type}-${sequence}` },
  };
}

describe("StreamBuffer", () => {
  it("coalesces multiple deltas into one frame flush", async () => {
    const onFlush = vi.fn();
    const buffer = new StreamBuffer(onFlush);

    buffer.push(makeEvent("text.delta", "st1", 1));
    buffer.push(makeEvent("text.delta", "st1", 2));
    buffer.push(makeEvent("text.delta", "st1", 3));

    // 等待 setTimeout 32ms +33ms buffer → ~100ms 足够 cover
    await new Promise((r) => setTimeout(r, 100));

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0]?.[0] as PlatformEventEnvelope[];
    expect(batch).toHaveLength(3);
    buffer.dispose();
  });

  it("keeps per-stream sequence order and drops duplicate events", async () => {
    const received: PlatformEventEnvelope[][] = [];
    const buffer = new StreamBuffer((events) => received.push([...events]));

    buffer.push(makeEvent("text.delta", "st1", 1));
    buffer.push(makeEvent("text.delta", "st1", 1)); // 重复
    buffer.push(makeEvent("text.delta", "st1", 2));

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]?.[0]?.sequence).toBe(1);
    expect(received[0]?.[1]?.sequence).toBe(2);
    buffer.dispose();
  });

  it("buffers events separately per streamId", async () => {
    const received: PlatformEventEnvelope[][] = [];
    const buffer = new StreamBuffer((events) => received.push([...events]));

    buffer.push(makeEvent("text.delta", "st1", 1));
    buffer.push(makeEvent("text.delta", "st2", 1));

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    buffer.dispose();
  });

  it("flushes pending events on turn completion and clears the buffer", async () => {
    const received: PlatformEventEnvelope[][] = [];
    const buffer = new StreamBuffer((events) => received.push([...events]));

    buffer.push(makeEvent("text.delta", "st1", 1));
    buffer.push(makeEvent("tool.start", "st1", 2));
    buffer.flushNow();
    expect(received).toHaveLength(1);

    buffer.push(makeEvent("text.delta", "st1", 3));
    buffer.push(makeEvent("message.completed", "st1", 4));
    buffer.flushNow();
    expect(received).toHaveLength(2);
    expect(received[1]).toHaveLength(2);

    // After flushNow, buffer should be cleared
    buffer.flushNow();
    expect(received).toHaveLength(2);
    buffer.dispose();
  });

  it("dispose prevents further flushes", async () => {
    const onFlush = vi.fn();
    const buffer = new StreamBuffer(onFlush);
    buffer.push(makeEvent("text.delta", "st1", 1));
    buffer.dispose();
    await new Promise((r) => setTimeout(r, 50));
    expect(onFlush).not.toHaveBeenCalled();
  });
});