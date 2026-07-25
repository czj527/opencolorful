import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { UsageRecorder } from "../../src/runtime/usage-recorder.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-usage-recorder-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const usageStore = new UsageStore(database);
  const replayStore = new EventReplayStore();
  return { paths, database, usageStore, replayStore };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function makeTurnCompletedEvent(
  sessionId: string,
  turnId: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number },
  context?: { tokens: number | null; contextWindow: number; percent: number | null },
  timestamp = "2026-07-25T12:00:00.000Z",
): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `evt-${turnId}`,
    sessionId,
    streamId: `stream-${turnId}`,
    sequence: 1,
    timestamp,
    type: "turn.completed",
    payload: {
      turnId,
      usage,
      ...(context !== undefined ? { context } : {}),
    },
  };
}

describe("UsageRecorder", () => {
  it("records turn.completed events with usage into the store", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => ({
      providerId: "faux",
      modelId: "faux-1",
    }));

    replayStore.publish(
      makeTurnCompletedEvent("session-1", "turn-1", {
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 10,
        totalTokens: 180,
      }),
    );

    // 订阅是异步通知（setImmediate），需要等待
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const totals = usageStore.sessionTotals("session-1");
        expect(totals.input).toBe(100);
        expect(totals.output).toBe(50);
        expect(totals.cacheRead).toBe(20);
        expect(totals.cacheWrite).toBe(10);
        expect(totals.totalTokens).toBe(180);
        expect(totals.turns).toBe(1);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("is idempotent for the same turnId", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    const event = makeTurnCompletedEvent("session-1", "turn-1", {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    });

    replayStore.publish(event);
    replayStore.publish(event);
    replayStore.publish(event);

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const totals = usageStore.sessionTotals("session-1");
        expect(totals.turns).toBe(1);
        expect(totals.input).toBe(10);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("uses 'unknown' for provider/model when resolver returns null", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    replayStore.publish(
      makeTurnCompletedEvent("session-1", "turn-1", {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
      }),
    );

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const summary = usageStore.summary(30);
        expect(summary.byModel[0]?.provider).toBe("unknown");
        expect(summary.byModel[0]?.model).toBe("unknown");
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("ignores non-turn.completed events", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    replayStore.publish({
      protocolVersion: 1,
      eventId: "evt-1",
      sessionId: "session-1",
      streamId: "stream-1",
      sequence: 1,
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "message.delta",
      payload: { role: "assistant", delta: "hello" },
    });

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(usageStore.sessionTotals("session-1").turns).toBe(0);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("ignores turn.completed without usage", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    replayStore.publish({
      protocolVersion: 1,
      eventId: "evt-1",
      sessionId: "session-1",
      streamId: "stream-1",
      sequence: 1,
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "turn.completed",
      payload: { turnId: "turn-1" },
    });

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(usageStore.sessionTotals("session-1").turns).toBe(0);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("records context snapshot when present", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    replayStore.publish(
      makeTurnCompletedEvent(
        "session-1",
        "turn-1",
        { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        { tokens: 8000, contextWindow: 128000, percent: 0.0625 },
      ),
    );

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const totals = usageStore.sessionTotals("session-1");
        expect(totals.contextTokens).toBe(8000);
        expect(totals.contextWindow).toBe(128000);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("stops recording after dispose", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    recorder.dispose();

    replayStore.publish(
      makeTurnCompletedEvent("session-1", "turn-1", {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      }),
    );

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(usageStore.sessionTotals("session-1").turns).toBe(0);
        database.close();
        resolve();
      });
    });
  });
});
