import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { UsageRecorder } from "../../src/runtime/usage-recorder.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-usage-recorder-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
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
  // 默认用当前时间：summary(days) 按 now-days 过滤，硬编码历史时间戳
  // 会在超过窗口期后变成日期炸弹（测试随日历翻转而失败）。
  timestamp = new Date().toISOString(),
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

function makeTerminalEvent(
  sessionId: string,
  type: "turn.failed" | "turn.cancelled" | "turn.interrupted",
  payload: { errorMessage?: string; reason?: string; turnId: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } },
): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `evt-${type}-${payload.turnId}`,
    sessionId,
    streamId: `stream-${payload.turnId}`,
    sequence: 2,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

interface UsageRow {
  source: string;
  role: string;
  status: string;
  agent_id: string | null;
  input: number;
  output: number;
  total_tokens: number;
}

function usageRows(database: Database.Database): UsageRow[] {
  return database
    .prepare("SELECT source, role, status, agent_id, input, output, total_tokens FROM usage_records ORDER BY id")
    .all() as UsageRow[];
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

  // ── A8a：主会话失败/取消/中断终态行（含 agentId 归属）──────────

  it("records turn.failed with payload usage as a failed main row", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => ({
      providerId: "faux",
      modelId: "faux-1",
    }), () => "agent-1");

    replayStore.publish(
      makeTerminalEvent("session-1", "turn.failed", {
        errorMessage: "模型调用失败",
        turnId: "turn-f1",
        usage: { input: 30, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 34 },
      }),
    );

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const rows = usageRows(database);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "main",
          role: "primary",
          status: "failed",
          agent_id: "agent-1",
          input: 30,
          output: 4,
          total_tokens: 34,
        });
        expect(usageStore.summary(30).byStatus).toContainEqual(
          expect.objectContaining({ status: "failed", calls: 1 }),
        );
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("records turn.cancelled and turn.interrupted rows with zero account when usage absent", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null, () => null);

    replayStore.publish(makeTerminalEvent("session-1", "turn.cancelled", { reason: "aborted", turnId: "turn-c1" }));
    replayStore.publish(makeTerminalEvent("session-1", "turn.interrupted", { reason: "session_disposed", turnId: "turn-i1" }));

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const rows = usageRows(database);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ source: "main", status: "cancelled", input: 0, output: 0, total_tokens: 0 });
        expect(rows[1]).toMatchObject({ source: "main", status: "interrupted", input: 0, output: 0, total_tokens: 0 });
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("does not double count duplicate terminal events (idempotent replay)", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => null);

    const event = makeTerminalEvent("session-1", "turn.failed", {
      errorMessage: "模型调用失败",
      turnId: "turn-dup",
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    });
    replayStore.publish(event);
    replayStore.publish({ ...event, eventId: "evt-replay-2" }); // 同 turnId 重放 → 同 dedupe 键

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const rows = usageRows(database);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.total_tokens).toBe(10);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });

  it("records one row per terminal status across a mixed lifecycle", () => {
    const { usageStore, replayStore, database } = createContext();
    const recorder = new UsageRecorder(replayStore, usageStore, () => ({
      providerId: "faux",
      modelId: "faux-1",
    }));

    replayStore.publish(
      makeTurnCompletedEvent("session-1", "turn-ok", {
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      }),
    );
    replayStore.publish(makeTerminalEvent("session-2", "turn.failed", { errorMessage: "boom", turnId: "turn-bad" }));
    replayStore.publish(makeTerminalEvent("session-3", "turn.cancelled", { reason: "aborted", turnId: "turn-abort" }));
    replayStore.publish(makeTerminalEvent("session-4", "turn.interrupted", { reason: "shutdown", turnId: "turn-int" }));

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const statuses = usageRows(database).map((row) => row.status).sort();
        expect(statuses).toEqual(["cancelled", "completed", "failed", "interrupted"]);
        // 三类非成功样例各有来源/角色正确的落库行
        for (const row of usageRows(database)) {
          expect(row.source).toBe("main");
          expect(row.role).toBe("primary");
        }
        expect(usageStore.summary(30).calls).toBe(4);
        recorder.dispose();
        database.close();
        resolve();
      });
    });
  });
});
