import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryWatermarkStore, SchedulerStateStore } from "../../src/storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { MemoryAgentScheduler } from "../../src/runtime/memory/scheduler.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-scheduler-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
  return { dir, paths, database, agentsDir };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function envelope(sessionId: string, type: PlatformEventEnvelope["type"], seq: number): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-${seq}`,
    sessionId,
    streamId: `stream-${sessionId}`,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    payload: type === "turn.completed" ? { turnId: `t-${seq}` } : { status: "idle" },
  };
}

function buildScheduler(
  database: Database.Database,
  agentsDir: string,
  opts: {
    now?: () => Date;
    resolver?: { runMaintenance: ReturnType<typeof vi.fn>; deepDive?: ReturnType<typeof vi.fn> };
    settings?: ReturnType<typeof defaultMemoryAgentSettings>;
    sessions?: Array<{ id: string; agentId: string; archived?: boolean }>;
  } = {},
) {
  const replayStore = new EventReplayStore();
  const settings = opts.settings ?? { ...defaultMemoryAgentSettings(), minIdleMinutes: 0, weeklyReviewDay: 3 };
  const sessions = opts.sessions ?? [{ id: "s1", agentId: "a1", sessionPath: path.join(agentsDir, "a1", "sessions", "s1.jsonl"), archived: false }];
  const sessionService = {
    getView: vi.fn((id: string) => sessions.find((s) => s.id === id) ?? { id, agentId: null, archived: false, sessionPath: "" }),
    list: vi.fn(({ agentId }: { agentId: string }) => sessions.filter((s) => s.agentId === agentId)),
  } as never;
  const promptService = { isBusy: vi.fn(() => false) } as never;
  const agentStore = { list: vi.fn(() => [{ identity: { id: "a1" } }]) } as never;
  const journalStore = new MemoryJournalStore(database);
  const batchStore = new MemoryBatchStore(database);
  const summaryStore = new SessionSummaryStore(database);
  const schedulerStore = new SchedulerStateStore(database);
  const resolver = opts.resolver ?? { runMaintenance: vi.fn(async () => ({ status: "completed", applied: 0, rejected: 0, batchIds: [], runId: "r" })), deepDive: vi.fn() };
  const scheduler = new MemoryAgentScheduler({
    replayStore,
    sessionService,
    promptService,
    agentStore,
    journalStore,
    batchStore,
    summaryStore,
    schedulerStore,
    settingsResolver: () => settings,
    resolver: resolver as never,
    tickMs: 3600_000,
    now: opts.now ?? (() => new Date("2026-08-01T12:00:00Z")),
  });
  return { scheduler, replayStore, journalStore, batchStore, schedulerStore, resolver };
}

describe("MemoryAgentScheduler", () => {
  it("每日窗口：时间达到 dailyRunTime 且空闲 → 运行维护并写 lastDailyCompletedAt", async () => {
    const { database, agentsDir } = createContext();
    const { scheduler, schedulerStore, resolver } = buildScheduler(database, agentsDir, {
      now: () => new Date("2026-08-02T03:10:00Z"),
    });
    await scheduler["tick"]();
    await scheduler.flush();
    expect(resolver.runMaintenance).toHaveBeenCalledTimes(1);
    const state = schedulerStore.get("a1");
    expect(state?.lastDailyCompletedAt?.slice(0, 10)).toBe("2026-08-02");
    expect(state?.status).toBe("idle");
  });

  it("未到 dailyRunTime 不运行", async () => {
    const { database, agentsDir } = createContext();
    const { scheduler, resolver } = buildScheduler(database, agentsDir, {
      now: () => new Date("2026-08-02T02:00:00Z"),
      settings: { ...defaultMemoryAgentSettings(), minIdleMinutes: 0, dailyRunTime: "03:00" },
    });
    await scheduler["tick"]();
    expect(resolver.runMaintenance).not.toHaveBeenCalled();
  });

  it("nextRetryAt 未到期跳过；到期后重试", async () => {
    const { database, agentsDir } = createContext();
    const { scheduler, schedulerStore, resolver } = buildScheduler(database, agentsDir, {
      now: () => new Date("2026-08-02T03:10:00Z"),
    });
    schedulerStore.upsert({
      agentId: "a1", status: "failed",
      nextRetryAt: "2026-08-02T03:30:00Z",
      updatedAt: "2026-08-02T03:05:00Z",
    });
    await scheduler["tick"]();
    expect(resolver.runMaintenance).not.toHaveBeenCalled();

    schedulerStore.upsert({
      agentId: "a1", status: "failed",
      nextRetryAt: "2026-08-02T03:00:00Z", // 已到期
      updatedAt: "2026-08-02T02:00:00Z",
    });
    await scheduler["tick"]();
    await scheduler.flush();
    expect(resolver.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("同一天只运行一次维护（doneMaintenanceDates 防重）", async () => {
    const { database, agentsDir } = createContext();
    const { scheduler, resolver } = buildScheduler(database, agentsDir, {
      now: () => new Date("2026-08-02T03:10:00Z"),
    });
    await scheduler["tick"]();
    await scheduler.flush();
    await scheduler["tick"]();
    await scheduler.flush();
    expect(resolver.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("高优先级 intent：turn.completed → micro-seal provisional 批次 + 专项维护", async () => {
    const { database, agentsDir } = createContext();
    const { scheduler, replayStore, journalStore, batchStore, resolver } = buildScheduler(database, agentsDir, {
      now: () => new Date("2026-08-02T12:00:00Z"),
    });
    // 高优先级 remember 意图（priority=1）
    journalStore.appendIntent({
      id: "hp-1", agentId: "a1", actor: "user", intentType: "remember",
      targetType: "fact", priority: 1, payload: { fact: "紧急记住" },
    });
    // 会话文件
    const sessionPath = path.join(agentsDir, "a1", "sessions", "s1.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "请记住" } }),
    ].join("\n") + "\n");

    replayStore.publish(envelope("s1", "turn.completed", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.flush();

    const batches = batchStore.listByAgent("a1");
    expect(batches.length).toBe(1);
    expect(batches[0]?.status).toBe("provisional");
    expect(batches[0]?.priority).toBe(1);
    expect(resolver.runMaintenance).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
