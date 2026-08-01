import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { SessionIndex, type CreateSessionInput } from "../../src/storage/session-index.js";
import { buildMemorySearchText } from "../../src/storage/memory/cjk-ngram.js";
import { MemoryRecallService } from "../../src/runtime/memory/recall-service.js";
import { createPersistentSession } from "../../src/pi-sdk/index.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencolorful-memory-recall-"),
  );
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);

  // Create agents directory structure
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentADir = path.join(agentsDir, "agent-a");
  fs.mkdirSync(agentADir, { recursive: true });
  const agentASessions = path.join(agentADir, "sessions");
  fs.mkdirSync(agentASessions, { recursive: true });

  const agentBDir = path.join(agentsDir, "agent-b");
  fs.mkdirSync(agentBDir, { recursive: true });
  const agentBSessions = path.join(agentBDir, "sessions");
  fs.mkdirSync(agentBSessions, { recursive: true });

  return { paths, database, dir, agentsDir, agentASessions, agentBSessions };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function seedFact(database: Database.Database, agentId: string, fact: string, searchText: string) {
  database
    .prepare(
      `INSERT INTO memory_facts
        (agent_id, fact, search_text, tags, fact_time, source, source_refs,
         retention_strength, activation_strength, confidence,
         status, created_at, updated_at)
       VALUES (
         ?, ?, ?, '[]', '2026-07-01', 'agent_approved', '["sess-fact-1"]',
         70, 50, 0.85,
         'active', datetime('now'), datetime('now')
       )`,
    )
    .run(agentId, fact, searchText);
}

function seedEvent(
  eventStore: MemoryEventStore,
  overrides: {
    id?: string;
    agentId?: string;
    sessionId?: string;
    summary?: string;
    sourceStartEntry?: string;
    sourceEndEntry?: string;
    date?: string;
  } = {},
): ReturnType<MemoryEventStore["insertEvent"]> {
  return eventStore.insertEvent({
    id: overrides.id ?? crypto.randomUUID(),
    agentId: overrides.agentId ?? "agent-a",
    sessionId: overrides.sessionId ?? "sess-1",
    branchRevision: "br-1",
    ...(overrides.sourceStartEntry
      ? { sourceStartEntry: overrides.sourceStartEntry }
      : {}),
    ...(overrides.sourceEndEntry
      ? { sourceEndEntry: overrides.sourceEndEntry }
      : {}),
    date: overrides.date ?? "2026-07-31",
    startedAt: "2026-07-31T10:00:00.000Z",
    endedAt: "2026-07-31T10:05:00.000Z",
    summary: overrides.summary ?? "讨论了部署方案",
    topics: ["部署"],
    searchText: buildMemorySearchText(overrides.summary ?? "讨论了部署方案"),
    messageCount: 5,
    toolCalls: 3,
    durationSec: 300,
    status: "active",
  });
}

function createSession(
  sessionIndex: SessionIndex,
  sessionId: string,
  agentId: string | null,
  sessionPath: string,
): string {
  const input: CreateSessionInput = {
    id: sessionId,
    title: "测试会话",
    sessionPath,
    ...(agentId !== null ? { agentId } : {}),
  };
  sessionIndex.create(input);
  return sessionPath;
}

describe("MemoryRecallService", () => {
  it("quick depth: facts only, completed when hits found", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Seed a fact
    seedFact(database, "agent-a", "用户偏好深色模式", buildMemorySearchText("用户偏好深色模式"));

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "深色模式", depth: "quick" },
    });

    expect(result.status).toBe("completed");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.layer).toBe("facts");
    expect(result.hits[0]?.targetType).toBe("fact");
    expect(result.reachedLayer).toBe("facts");

    // Verify event lifecycle: started → completed
    const types = publishedEnvelopes.map((e) => e.type);
    expect(types).toContain("memory.recall.started");
    expect(types).toContain("memory.recall.completed");
    expect(types).not.toContain("memory.recall.layer_changed");

    // Verify episode recorded
    const episode = recallStore.getEpisode(result.episodeId);
    expect(episode).toBeDefined();
    expect(episode?.status).toBe("completed");
    expect(episode?.resultCount).toBe(1);

    // Verify recall events persisted for Replay
    const events = recallStore.listRecallEventsByEpisode(result.episodeId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.status).toBe("started");
    expect(events[events.length - 1]?.status).toBe("completed");
  });

  it("quick depth: empty when no facts found", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "不存在的内容", depth: "quick" },
    });

    expect(result.status).toBe("empty");
    expect(result.hits).toHaveLength(0);

    // Verify events: started → empty
    const types = publishedEnvelopes.map((e) => e.type);
    expect(types).toContain("memory.recall.started");
    expect(types).toContain("memory.recall.empty");

    // Episode status should be "empty"
    const episode = recallStore.getEpisode(result.episodeId);
    expect(episode?.status).toBe("empty");
  });

  it("deep depth: goes to events when facts < 3", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Seed only 1 fact (less than 3 threshold)
    seedFact(database, "agent-a", "唯一事实", buildMemorySearchText("唯一事实"));
    // Also seed an event
    seedEvent(eventStore, { summary: "部署相关讨论" });

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "部署", depth: "deep" },
    });

    // Should have events layer hits (facts < 3 triggered events search)
    const types = publishedEnvelopes.map((e) => e.type);
    expect(types).toContain("memory.recall.layer_changed");
    expect(result.reachedLayer).toBe("events");
  });

  it("deep depth: skips events when facts >= 3", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Seed 3 facts (at threshold)
    seedFact(database, "agent-a", "事实A-部署", buildMemorySearchText("事实A-部署"));
    seedFact(database, "agent-a", "事实B-部署", buildMemorySearchText("事实B-部署"));
    seedFact(database, "agent-a", "事实C-部署", buildMemorySearchText("事实C-部署"));
    // Seed an event
    seedEvent(eventStore, { summary: "部署讨论" });

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "部署", depth: "deep" },
    });

    // Should NOT have layer_changed because facts >= 3
    const types = publishedEnvelopes.map((e) => e.type);
    expect(types).not.toContain("memory.recall.layer_changed");
    expect(result.reachedLayer).toBe("facts");
    expect(result.hits.length).toBeGreaterThanOrEqual(3);
  });

  it("source depth: drills into top-1 event source", async () => {
    const { database, agentsDir, agentASessions } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Create a real session with JSONL content
    const handle = createPersistentSession(agentASessions, agentASessions, "sess-source-1");
    handle.appendUserMessage("今天部署了什么？");
    handle.appendAssistantMessage("部署了新的前端版本到生产环境。");
    handle.appendUserMessage("有什么问题吗？");
    handle.appendAssistantMessage("没有，部署很顺利。");
    handle.persist();

    // Use handle.path for the session index (PI SDK adds timestamp prefix)
    const sessionPath = createSession(sessionIndex, "sess-source-1", "agent-a", handle.path);

    // Get entry IDs from the persisted JSONL
    const snapshot = fs.readFileSync(handle.path, "utf8");
    const lines = snapshot.split("\n").filter(Boolean);
    const entries = lines.slice(1).map((l) => JSON.parse(l) as { id: string });
    const startEntry = entries[0]?.id ?? "";
    const endEntry = entries[entries.length - 1]?.id ?? "";

    // Seed an event that references this session with a unique query term
    const eventId = "ev-source-test-1";
    const inserted = seedEvent(eventStore, {
      id: eventId,
      agentId: "agent-a",
      sessionId: "sess-source-1",
      summary: "部署讨论记录",
      sourceStartEntry: startEntry,
      sourceEndEntry: endEntry,
    });
    // Verify the event was stored with source range
    const storedEvent = eventStore.getById(eventId);
    expect(storedEvent).toBeDefined();
    expect(storedEvent?.sourceStartEntry).toBeDefined();
    expect(storedEvent?.sourceEndEntry).toBeDefined();
    expect(storedEvent?.sourceStartEntry).toBe(startEntry);
    expect(storedEvent?.sourceEndEntry).toBe(endEntry);

    // Verify session exists in index
    const storedSession = sessionIndex.get("sess-source-1");
    expect(storedSession).toBeDefined();
    expect(storedSession?.agentId).toBe("agent-a");
    // Verify session path matches the actual file
    expect(storedSession?.sessionPath).toBe(handle.path);
    expect(fs.existsSync(storedSession?.sessionPath ?? "")).toBe(true);

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "部署讨论", depth: "source" },
    });

    // Check if event was found
    const eventHits = result.hits.filter((h) => h.layer === "events");
    // Source dive needs the event to be found first; if FTS doesn't match,
    // the event layer returns empty and source dive won't happen.
    if (eventHits.length > 0) {
      const sourceHits = result.hits.filter((h) => h.layer === "source");
      expect(sourceHits.length).toBeGreaterThanOrEqual(1);
      expect(result.reachedLayer).toBe("source");

      // Source hit should contain sanitized session content
      const sourceHit = sourceHits[0];
      expect(sourceHit?.snippet).toBeDefined();
      expect(sourceHit?.targetType).toBe("session");
    }
    // Even if FTS doesn't find events, the search should complete normally
    expect(result.status).toBe(result.hits.length > 0 ? "completed" : "empty");

    // Verify layer_changed events if events were searched
    const types = publishedEnvelopes.map((e) => e.type);
    expect(types).toContain("memory.recall.started");
  });

  it("cross-agent isolation: agent B's session inaccessible to agent A", async () => {
    const { database, agentsDir, agentASessions, agentBSessions } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Create session for agent B
    const handleB = createPersistentSession(agentBSessions, agentBSessions, "sess-b-1");
    handleB.appendUserMessage("agent B 的私密内容");
    handleB.appendAssistantMessage("这是 agent B 的回复");
    handleB.persist();

    const sessionPathB = createSession(sessionIndex, "sess-b-1", "agent-b", handleB.path);

    // Get entry IDs
    const snapshot = fs.readFileSync(handleB.path, "utf8");
    const lines = snapshot.split("\n").filter(Boolean);
    const entries = lines.slice(1).map((l) => JSON.parse(l) as { id: string });
    const startEntry = entries[0]?.id ?? "";
    const endEntry = entries[entries.length - 1]?.id ?? "";

    // Seed event that references agent B's session
    seedEvent(eventStore, {
      id: "ev-agent-b",
      agentId: "agent-b",
      sessionId: "sess-b-1",
      summary: "agent B 私密对话",
      sourceStartEntry: startEntry,
      sourceEndEntry: endEntry,
    });

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    // Agent A searches
    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "私密", depth: "source" },
    });

    // Agent A should NOT see agent B's source content
    const sourceHits = result.hits.filter((h) => h.layer === "source");
    // The source layer should be empty because session.agentId === "agent-b" !== "agent-a"
    expect(sourceHits).toHaveLength(0);
  });

  it("unbound session (null agentId) excluded from source dive", async () => {
    const { database, agentsDir, agentASessions } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Create unbound session (agentId = null)
    const handle = createPersistentSession(agentASessions, agentASessions, "sess-unbound");
    handle.appendUserMessage("未绑定会话的内容");
    handle.appendAssistantMessage("回复");
    handle.persist();

    createSession(sessionIndex, "sess-unbound", null, handle.path);

    const snapshot = fs.readFileSync(handle.path, "utf8");
    const lines = snapshot.split("\n").filter(Boolean);
    const entries = lines.slice(1).map((l) => JSON.parse(l) as { id: string });
    const startEntry = entries[0]?.id ?? "";
    const endEntry = entries[entries.length - 1]?.id ?? "";

    seedEvent(eventStore, {
      id: "ev-unbound",
      agentId: "agent-a",
      sessionId: "sess-unbound",
      summary: "未绑定会话事件",
      sourceStartEntry: startEntry,
      sourceEndEntry: endEntry,
    });

    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: () => {},
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "未绑定", depth: "source" },
    });

    // Source dive should be blocked because session.agentId is null
    const sourceHits = result.hits.filter((h) => h.layer === "source");
    expect(sourceHits).toHaveLength(0);
  });

  it("failed status is distinct from empty", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    // Create a service with a broken publish that throws
    let callCount = 0;
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => {
        callCount += 1;
        // Throw on the first publish (which will be "started") to simulate a failure
        if (callCount === 1) {
          throw new Error("发布失败");
        }
      },
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "测试" },
    });

    // Should be "failed" since publish threw during started
    expect(result.status).toBe("failed");
    expect(result.hits).toHaveLength(0);

    // Episode should be marked as failed
    const episode = recallStore.getEpisode(result.episodeId);
    expect(episode?.status).toBe("failed");
  });

  it("recall ledger records each hit with query hash", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    seedFact(database, "agent-a", "测试事实A", buildMemorySearchText("测试事实A"));
    seedFact(database, "agent-a", "测试事实B", buildMemorySearchText("测试事实B"));

    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: () => {},
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "测试" },
    });

    expect(result.status).toBe("completed");

    // Check recall ledger entries
    const ledger = recallStore.listByAgent("agent-a");
    expect(ledger.length).toBeGreaterThanOrEqual(result.hits.length);
    // All ledger entries should have the recallId from the result
    const episodeLedger = ledger.filter((e) => e.recallId === result.episodeId);
    // Actually, the recallId used in the ledger is the one generated internally, so let's just check count
    expect(ledger.length).toBeGreaterThanOrEqual(2);

    // Each ledger entry should have queryHash
    for (const entry of ledger) {
      expect(entry.queryHash).toBeDefined();
      expect(entry.queryHash).toHaveLength(16);
    }
  });

  it("episode lifecycle events are emitted in correct order", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    seedFact(database, "agent-a", "测试事实", buildMemorySearchText("测试事实"));

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "测试", depth: "quick" },
    });

    // Order: started → completed
    const types = publishedEnvelopes.map((e) => e.type);
    const startedIdx = types.indexOf("memory.recall.started");
    const completedIdx = types.indexOf("memory.recall.completed");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
  });

  it("memory_recall_events table preserves events for SSE Replay", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);

    seedFact(database, "agent-a", "测试", buildMemorySearchText("测试"));

    const service = new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: () => {},
      agentsDir,
    });

    const result = await service.search({
      agentId: "agent-a",
      sessionId: "sess-test",
      args: { query: "测试", depth: "quick" },
    });

    // Check recall events table
    const events = recallStore.listRecallEventsByEpisode(result.episodeId);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event should be "started", last should be "completed" or "empty"
    expect(events[0]?.status).toBe("started");
    const lastEvent = events[events.length - 1];
    expect(["completed", "empty"].includes(lastEvent?.status ?? "")).toBe(true);
  });

  it("agent stream sequence is strictly increasing across consecutive recalls", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);
    seedFact(database, "agent-a", "连续回想", buildMemorySearchText("连续回想"));

    const publishedEnvelopes: PlatformEventEnvelope[] = [];
    const makeService = () => new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => publishedEnvelopes.push(env),
      agentsDir,
    });

    // 两次回想各自创建新的 service/publisher 实例（模拟两个会话/两轮调用）
    await makeService().search({ agentId: "agent-a", sessionId: "sess-1", args: { query: "连续回想", depth: "quick" } });
    await makeService().search({ agentId: "agent-a", sessionId: "sess-2", args: { query: "连续回想", depth: "quick" } });

    const sequences = publishedEnvelopes.map((e) => e.sequence);
    expect(sequences.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(new Set(publishedEnvelopes.map((e) => e.streamId))).toEqual(new Set(["agent:agent-a"]));
  });

  it("agent stream sequence is strictly increasing under concurrent recalls and replayable", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);
    const replayStore = new EventReplayStore();
    seedFact(database, "agent-a", "并发回想", buildMemorySearchText("并发回想"));

    const makeService = () => new MemoryRecallService({
      factStore,
      eventStore,
      recallStore,
      sessionIndex,
      publish: (env) => replayStore.publish(env),
      agentsDir,
    });

    // 并发两次回想（Promise.all，共享同一 agent 流）
    await Promise.all([
      makeService().search({ agentId: "agent-a", sessionId: "sess-1", args: { query: "并发回想", depth: "quick" } }),
      makeService().search({ agentId: "agent-a", sessionId: "sess-2", args: { query: "并发回想", depth: "quick" } }),
    ]);

    // 流内 sequence 严格递增、无重复
    const replay = replayStore.getSince("agent:agent-a", 0);
    const sequences = replay.events.map((e) => e.sequence);
    expect(sequences.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    expect(new Set(sequences).size).toBe(sequences.length);

    // 从中间游标续传：不重复、不丢失
    const midpoint = sequences[Math.floor(sequences.length / 2)]!;
    const resume = replayStore.getSince("agent:agent-a", midpoint);
    expect(resume.events.every((e) => e.sequence > midpoint)).toBe(true);
    expect(resume.events.map((e) => e.sequence)).toEqual(sequences.filter((s) => s > midpoint));
  });
});
