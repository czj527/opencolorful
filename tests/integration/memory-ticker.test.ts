import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentStore } from "../../src/config/agent-store.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { MemoryTicker } from "../../src/runtime/memory/memory-ticker.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";

const contexts: Array<{ dir: string; close: () => void }> = [];

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.close();
    fs.rmSync(context.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function makeContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-ticker-"));
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  contexts.push({ dir, close: () => database.close() });
  return { dir, paths, database };
}

function event(sessionId: string, type: PlatformEventEnvelope["type"], sequence: number): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-${sequence}`,
    sessionId,
    streamId: `stream-${sessionId}`,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload: type === "turn.completed" ? { turnId: `turn-${sequence}` } : { status: "idle" },
  };
}

describe("MemoryTicker", () => {
  it("10 轮才触发一次摘要，并为事件创建 sealed batch", async () => {
    const { paths, database } = makeContext();
    const replayStore = new EventReplayStore();
    const view = {
      id: "s1", title: "测试", sessionPath: path.join(paths.home, "s1.jsonl"),
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", archived: false,
      agentId: "a1", toolMode: "off", workspaceCwd: null, workspaceConfirmed: false,
      messages: [], messageEntries: [], model: null,
    };
    fs.mkdirSync(path.dirname(view.sessionPath), { recursive: true });
    fs.writeFileSync(view.sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello" } }),
    ].join("\n") + "\n");
    const sessionService = { getView: vi.fn(() => view), list: vi.fn(() => [view]) } as never;
    const promptService = { isBusy: vi.fn(() => false) } as never;
    const agentStore = { list: vi.fn(() => [{ identity: { id: "a1" } }]) } as never;
    const summaryStore = new SessionSummaryStore(database);
    const watermarkStore = new MemoryWatermarkStore(database);
    const batchStore = new MemoryBatchStore(database);
    const rollingSummary = { maybeSummarize: vi.fn(async () => ({ status: "updated" as const, branchRevision: "rev", messageCount: 1 })) };
    const eventIndexer = { indexSession: vi.fn(() => ({ status: "indexed" as const, eventId: "ev_1" })) };
    const ticker = new MemoryTicker({
      replayStore, sessionService, promptService, agentStore,
      summaryStore, batchStore, watermarkStore, rollingSummary, eventIndexer,
      turnsPerSummary: 10,
    });
    for (let i = 1; i <= 9; i += 1) replayStore.publish(event("s1", "turn.completed", i));
    await new Promise((resolve) => setImmediate(resolve));
    expect(rollingSummary.maybeSummarize).not.toHaveBeenCalled();
    replayStore.publish(event("s1", "turn.completed", 10));
    await new Promise((resolve) => setImmediate(resolve));
    await ticker.flush();
    expect(rollingSummary.maybeSummarize).toHaveBeenCalledTimes(1);
    expect(batchStore.listPendingBatches("a1")).toHaveLength(1);
    ticker.stop();
  });

  it("LLM degraded 时保留 dirty watermark，不创建假 batch", async () => {
    const { paths, database } = makeContext();
    const replayStore = new EventReplayStore();
    const view = {
      id: "s2", title: "测试", sessionPath: path.join(paths.home, "s2.jsonl"),
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", archived: false,
      agentId: "a1", toolMode: "off", workspaceCwd: null, workspaceConfirmed: false,
      messages: [], messageEntries: [], model: null,
    };
    fs.mkdirSync(path.dirname(view.sessionPath), { recursive: true });
    fs.writeFileSync(view.sessionPath, JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: new Date().toISOString() }) + "\n");
    const ticker = new MemoryTicker({
      replayStore,
      sessionService: { getView: vi.fn(() => view), list: vi.fn(() => []) } as never,
      promptService: { isBusy: vi.fn(() => false) } as never,
      agentStore: { list: vi.fn(() => []) } as never,
      summaryStore: new SessionSummaryStore(database),
      batchStore: new MemoryBatchStore(database),
      watermarkStore: new MemoryWatermarkStore(database),
      rollingSummary: { maybeSummarize: vi.fn(async () => ({ status: "degraded" as const, reason: "LLM 不可用" })) },
      eventIndexer: { indexSession: vi.fn() },
      turnsPerSummary: 1,
    });
    replayStore.publish(event("s2", "turn.completed", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await ticker.flush();
    expect(new MemoryBatchStore(database).listPendingBatches("a1")).toHaveLength(0);
    ticker.stop();
  });
});
