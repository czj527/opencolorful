import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  buildMemorySearchText,
  buildMemoryFtsQuery,
  isSingleCjkQuery,
} from "../../src/storage/memory/cjk-ngram.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import {
  MemoryDailyStateStore,
  MemoryWatermarkStore,
  SchedulerStateStore,
} from "../../src/storage/memory/recovery-store.js";
import { PinnedMemoryStore } from "../../src/storage/memory/pinned-store.js";
import type Database from "better-sqlite3";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencolorful-memory-stores-"),
  );
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { paths, database };
}

afterEach(() => {
  // 先关闭所有数据库句柄，避免 Windows 文件占用导致 rm 失败
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭或无效句柄，忽略
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function closeAndCleanup(database: Database.Database) {
  database.close();
}

// ─── helpers ─────────────────────────────────────────────────────

function makeEventInput(
  overrides: Partial<{
    id: string;
    agentId: string;
    sessionId: string;
    branchRevision: string;
    sourceStartEntry: string;
    sourceEndEntry: string;
    date: string;
    summary: string;
    searchText: string;
    topics: readonly string[];
  }> = {},
) {
  const summary = overrides.summary ?? "用户讨论了部署方案";
  return {
    id: overrides.id ?? "ev-1",
    agentId: overrides.agentId ?? "agent-1",
    sessionId: overrides.sessionId ?? "sess-1",
    branchRevision: overrides.branchRevision ?? "br-1",
    ...(overrides.sourceStartEntry !== undefined
      ? { sourceStartEntry: overrides.sourceStartEntry }
      : {}),
    ...(overrides.sourceEndEntry !== undefined
      ? { sourceEndEntry: overrides.sourceEndEntry }
      : {}),
    date: overrides.date ?? "2026-07-31",
    startedAt: "2026-07-31T10:00:00.000Z",
    endedAt: "2026-07-31T10:05:00.000Z",
    summary,
    topics: overrides.topics ?? (["部署", "方案"] as readonly string[]),
    searchText: overrides.searchText ?? buildMemorySearchText(summary),
    messageCount: 4,
    toolCalls: 2,
    durationSec: 300,
    status: "active" as const,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SessionSummaryStore
// ═══════════════════════════════════════════════════════════════════
describe("SessionSummaryStore", () => {
  it("upserts and retrieves a summary", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    const result = store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-1",
      agentId: "agent-1",
      summary: "测试摘要",
      messageCount: 10,
      cursor: { lastEntry: "e5" },
      sourceStartEntry: "e1",
      sourceEndEntry: "e5",
    });

    expect(result.sessionId).toBe("sess-1");
    expect(result.branchRevision).toBe("br-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.summary).toBe("测试摘要");
    expect(result.messageCount).toBe(10);
    expect(result.cursor).toEqual({ lastEntry: "e5" });
    expect(result.sourceStartEntry).toBe("e1");
    expect(result.sourceEndEntry).toBe("e5");

    closeAndCleanup(database);
  });

  it("upsert updates existing row (composite key)", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-1",
      agentId: "agent-1",
      summary: "旧摘要",
      messageCount: 5,
      cursor: {},
    });

    const updated = store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-1",
      agentId: "agent-1",
      summary: "新摘要",
      messageCount: 20,
      cursor: { latest: "e99" },
    });

    expect(updated.summary).toBe("新摘要");
    expect(updated.messageCount).toBe(20);
    expect(updated.cursor).toEqual({ latest: "e99" });

    // created_at should be preserved from first insert
    const count = database
      .prepare(
        "SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = 'sess-1'",
      )
      .pluck()
      .get() as number;
    expect(count).toBe(1);

    closeAndCleanup(database);
  });

  it("gets by composite key", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-a",
      agentId: "agent-1",
      summary: "A",
      messageCount: 1,
      cursor: {},
    });
    store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-b",
      agentId: "agent-1",
      summary: "B",
      messageCount: 2,
      cursor: {},
    });

    expect(store.get("sess-1", "br-a")?.summary).toBe("A");
    expect(store.get("sess-1", "br-b")?.summary).toBe("B");
    expect(store.get("sess-1", "br-c")).toBeUndefined();

    closeAndCleanup(database);
  });

  it("listByAgent returns summaries for an agent", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-1",
      agentId: "agent-1",
      summary: "A",
      messageCount: 1,
      cursor: {},
    });
    store.upsert({
      sessionId: "sess-2",
      branchRevision: "br-1",
      agentId: "agent-2",
      summary: "B",
      messageCount: 2,
      cursor: {},
    });

    const list1 = store.listByAgent("agent-1");
    expect(list1).toHaveLength(1);
    expect(list1[0]?.sessionId).toBe("sess-1");

    const list2 = store.listByAgent("agent-2");
    expect(list2).toHaveLength(1);

    closeAndCleanup(database);
  });

  it("updateSummaryWithCursor atomically updates fields", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    store.upsert({
      sessionId: "sess-1",
      branchRevision: "br-1",
      agentId: "agent-1",
      summary: "旧摘要",
      messageCount: 5,
      cursor: {},
    });

    const updated = store.updateSummaryWithCursor("sess-1", "br-1", {
      summary: "新摘要",
      cursor: { lastEntry: "e99" },
      messageCount: 30,
      sourceStartEntry: "e1",
      sourceEndEntry: "e99",
    });

    expect(updated.summary).toBe("新摘要");
    expect(updated.cursor).toEqual({ lastEntry: "e99" });
    expect(updated.messageCount).toBe(30);
    expect(updated.sourceStartEntry).toBe("e1");
    expect(updated.sourceEndEntry).toBe("e99");

    closeAndCleanup(database);
  });

  it("updateSummaryWithCursor throws for missing row", () => {
    const { database } = createContext();
    const store = new SessionSummaryStore(database);

    expect(() =>
      store.updateSummaryWithCursor("nonexistent", "br-1", {
        summary: "test",
        cursor: {},
        messageCount: 10,
      }),
    ).toThrow(/Session 摘要不存在/);

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryEventStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryEventStore", () => {
  it("inserts and retrieves an event", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    const input = makeEventInput();
    const inserted = store.insertEvent(input);
    expect(inserted).toBe(true);

    const event = store.getById("ev-1");
    expect(event).toBeDefined();
    expect(event?.agentId).toBe("agent-1");
    expect(event?.summary).toContain("部署");
    expect(event?.topics).toEqual(["部署", "方案"]);

    closeAndCleanup(database);
  });

  it("is idempotent: same source batch returns false on second insert", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    const input = makeEventInput({
      sourceStartEntry: "e1",
      sourceEndEntry: "e5",
    });

    const first = store.insertEvent(input);
    expect(first).toBe(true);

    // 同 source batch，换个 id 也冲突（UNIQUE 约束不包含 id）
    const second = store.insertEvent({
      ...input,
      id: "ev-2",
    });
    expect(second).toBe(false);

    // 验证只有一条记录
    const rows = database
      .prepare("SELECT COUNT(*) AS c FROM memory_events")
      .pluck()
      .get() as number;
    expect(rows).toBe(1);

    closeAndCleanup(database);
  });

  it("listByAgentAndDateRange filters by date range", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(makeEventInput({ id: "ev-1", date: "2026-07-01", summary: "早期事件" }));
    store.insertEvent(makeEventInput({ id: "ev-2", date: "2026-07-15", summary: "中期事件" }));
    store.insertEvent(makeEventInput({ id: "ev-3", date: "2026-07-31", summary: "近期事件" }));

    const all = store.listByAgentAndDateRange("agent-1");
    expect(all).toHaveLength(3);

    const from15 = store.listByAgentAndDateRange("agent-1", "2026-07-15");
    expect(from15).toHaveLength(2);

    const range = store.listByAgentAndDateRange("agent-1", "2026-07-10", "2026-07-20");
    expect(range).toHaveLength(1);
    expect(range[0]?.id).toBe("ev-2");

    closeAndCleanup(database);
  });

  it("listByAgentAndDateRange excludes forgotten/suppressed", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(makeEventInput({ id: "ev-1" }));
    store.insertEvent(makeEventInput({ id: "ev-2" }));
    store.updateStatus("ev-2", "forgotten");

    const list = store.listByAgentAndDateRange("agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("ev-1");

    closeAndCleanup(database);
  });

  it("updateStatus changes event status", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(makeEventInput({ id: "ev-1" }));
    const updated = store.updateStatus("ev-1", "suppressed");
    expect(updated.status).toBe("suppressed");

    closeAndCleanup(database);
  });

  it("updateStatus throws for missing event", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    expect(() => store.updateStatus("nonexistent", "forgotten")).toThrow(
      /事件不存在/,
    );

    closeAndCleanup(database);
  });

  it("searchByFts finds events using FTS5", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(
      makeEventInput({
        id: "ev-1",
        summary: "用户讨论了部署方案",
        searchText: buildMemorySearchText("用户讨论了部署方案"),
        topics: ["部署", "方案"],
      }),
    );
    store.insertEvent(
      makeEventInput({
        id: "ev-2",
        summary: "分析了性能问题",
        searchText: buildMemorySearchText("分析了性能问题"),
        topics: ["性能"],
      }),
    );

    const results = store.searchByFts("agent-1", "部署方案");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("ev-1");

    closeAndCleanup(database);
  });

  it("searchByFts falls back to LIKE for single CJK query", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(
      makeEventInput({
        id: "ev-single",
        summary: "聊",
        searchText: buildMemorySearchText("聊"),
      }),
    );
    store.insertEvent(
      makeEventInput({
        id: "ev-other",
        summary: "讨论了部署方案",
        searchText: buildMemorySearchText("讨论了部署方案"),
      }),
    );

    // 单字 CJK 查询应走 LIKE 降级
    expect(isSingleCjkQuery("聊")).toBe(true);
    const results = store.searchByFts("agent-1", "聊");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("ev-single");

    closeAndCleanup(database);
  });

  it("searchByFts excludes forgotten/suppressed", () => {
    const { database } = createContext();
    const store = new MemoryEventStore(database);

    store.insertEvent(
      makeEventInput({
        id: "ev-1",
        summary: "部署方案讨论",
        searchText: buildMemorySearchText("部署方案讨论"),
        topics: ["部署"],
      }),
    );
    store.insertEvent(
      makeEventInput({
        id: "ev-2",
        summary: "部署计划回顾",
        searchText: buildMemorySearchText("部署计划回顾"),
        topics: ["部署"],
      }),
    );
    store.updateStatus("ev-2", "forgotten");

    const results = store.searchByFts("agent-1", "部署");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("ev-1");

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryFactStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryFactStore", () => {
  it("getById returns a fact", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    // raw SQL INSERT for test data
    const searchText = buildMemorySearchText("用户偏好深色模式");
    database
      .prepare(
        `INSERT INTO memory_facts
          (agent_id, fact, search_text, tags, fact_time, source, source_refs,
           retention_strength, activation_strength, confidence,
           status, created_at, updated_at)
         VALUES (
           'agent-1', '用户偏好深色模式', ?, '["偏好","UI"]',
           '2026-07-01', 'agent_approved', '[]',
           60, 40, 0.85,
           'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z'
         )`,
      )
      .run(searchText);

    const fact = store.getById(1);
    expect(fact).toBeDefined();
    expect(fact?.fact).toBe("用户偏好深色模式");
    expect(fact?.tags).toEqual(["偏好", "UI"]);
    expect(fact?.retentionStrength).toBe(60);

    closeAndCleanup(database);
  });

  it("listByAgent returns facts excluding forgotten/suppressed", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    const s1 = buildMemorySearchText("F1");
    const s2 = buildMemorySearchText("F2");
    const s3 = buildMemorySearchText("F3");

    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', 'F1', ?, 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(s1);
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', 'F2', ?, 'forgotten', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(s2);
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', 'F3', ?, 'superseded', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(s3);

    const list = store.listByAgent("agent-1");
    // superseded 保留，forgotten/suppressed 排除
    expect(list).toHaveLength(2);
    const facts = list.map((f) => f.fact);
    expect(facts).toContain("F1");
    expect(facts).toContain("F3");
    expect(facts).not.toContain("F2");

    closeAndCleanup(database);
  });

  it("listByAgent filters by tags using json_each exact match", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, tags, status, created_at, updated_at)
         VALUES ('agent-1', '偏好深色', '', '["偏好","UI"]', 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, tags, status, created_at, updated_at)
         VALUES ('agent-1', '喜欢清淡', '', '["偏好","饮食"]', 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, tags, status, created_at, updated_at)
         VALUES ('agent-1', '其他事实', '', '["其他"]', 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run();

    const tagged = store.listByAgent("agent-1", { tags: ["偏好"] });
    expect(tagged).toHaveLength(2);

    // 多标签 AND 过滤
    const multiTag = store.listByAgent("agent-1", {
      tags: ["偏好", "UI"],
    });
    expect(multiTag).toHaveLength(1);
    expect(multiTag[0]?.fact).toBe("偏好深色");

    closeAndCleanup(database);
  });

  it("searchByFts finds facts via FTS5", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', '用户偏好深色模式', ?, 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(buildMemorySearchText("用户偏好深色模式"));
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', '无关事实', ?, 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(buildMemorySearchText("无关事实"));

    const results = store.searchByFts("agent-1", "深色模式");
    expect(results).toHaveLength(1);
    expect(results[0]?.fact).toBe("用户偏好深色模式");

    closeAndCleanup(database);
  });

  it("searchByFts falls back to LIKE for single CJK", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-1', '色', ?, 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')`,
      )
      .run(buildMemorySearchText("色"));

    expect(isSingleCjkQuery("色")).toBe(true);
    const results = store.searchByFts("agent-1", "色");
    expect(results).toHaveLength(1);
    expect(results[0]?.fact).toBe("色");

    closeAndCleanup(database);
  });

  it("has no write methods (Phase 10 read-only)", () => {
    const { database } = createContext();
    const store = new MemoryFactStore(database);

    // 验证 store 实例上没有 insert/update/delete/upsert 方法
    const s = store as unknown as Record<string, unknown>;
    expect(typeof s["insert"]).toBe("undefined");
    expect(typeof s["update"]).toBe("undefined");
    expect(typeof s["delete"]).toBe("undefined");
    expect(typeof s["upsert"]).toBe("undefined");

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryRecallStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryRecallStore", () => {
  it("appends recall entries and lists by agent", () => {
    const { database } = createContext();
    const store = new MemoryRecallStore(database);

    store.appendRecall({
      agentId: "agent-1",
      sessionId: "sess-1",
      recallId: "rec-1",
      targetType: "fact",
      targetId: "1",
      queryHash: "abc123",
      layer: "facts",
    });

    store.appendRecall({
      agentId: "agent-1",
      sessionId: "sess-1",
      recallId: "rec-2",
      targetType: "event",
      targetId: "ev-1",
      queryHash: "def456",
      layer: "events",
      sourceType: "custom_source",
    });

    const list = store.listByAgent("agent-1");
    expect(list).toHaveLength(2);
    expect(list[1]?.recallId).toBe("rec-1"); // 倒序排列

    // sourceType 默认值
    expect(list[0]?.sourceType).toBe("custom_source");

    closeAndCleanup(database);
  });

  it("listByAgent supports since filter", async () => {
    const { database } = createContext();
    const store = new MemoryRecallStore(database);

    store.appendRecall({
      agentId: "agent-1",
      sessionId: "sess-1",
      recallId: "old",
      targetType: "fact",
      targetId: "1",
      queryHash: "old",
      layer: "facts",
    });

    // 等待至少 2ms 确保时间戳不同
    await new Promise((resolve) => setTimeout(resolve, 2));
    const since = new Date().toISOString();

    store.appendRecall({
      agentId: "agent-1",
      sessionId: "sess-1",
      recallId: "new",
      targetType: "fact",
      targetId: "2",
      queryHash: "new",
      layer: "facts",
    });

    const filtered = store.listByAgent("agent-1", { since });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.recallId).toBe("new");

    closeAndCleanup(database);
  });

  it("creates and updates episodes", () => {
    const { database } = createContext();
    const store = new MemoryRecallStore(database);

    const episode = store.createEpisode({
      id: "ep-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      status: "started",
      resultCount: 0,
      startedAt: "2026-07-31T10:00:00.000Z",
    });

    expect(episode.id).toBe("ep-1");
    expect(episode.status).toBe("started");

    const updated = store.updateEpisode("ep-1", {
      status: "completed",
      resultCount: 5,
      completedAt: "2026-07-31T10:05:00.000Z",
    });

    expect(updated.status).toBe("completed");
    expect(updated.resultCount).toBe(5);
    expect(updated.completedAt).toBe("2026-07-31T10:05:00.000Z");

    closeAndCleanup(database);
  });

  it("updateEpisode throws for missing episode", () => {
    const { database } = createContext();
    const store = new MemoryRecallStore(database);

    expect(() =>
      store.updateEpisode("nonexistent", { status: "completed" }),
    ).toThrow(/回想 Episode 不存在/);

    closeAndCleanup(database);
  });

  it("appends recall events and lists by episode for SSE replay", () => {
    const { database } = createContext();
    const store = new MemoryRecallStore(database);

    store.createEpisode({
      id: "ep-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      status: "started",
      resultCount: 0,
      startedAt: "2026-07-31T10:00:00.000Z",
    });

    store.appendRecallEvent({
      episodeId: "ep-1",
      recallId: "rec-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      status: "started",
      resultCount: 0,
    });

    store.appendRecallEvent({
      episodeId: "ep-1",
      recallId: "rec-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      layer: "facts",
      status: "layer_changed",
      resultCount: 3,
    });

    store.appendRecallEvent({
      episodeId: "ep-1",
      recallId: "rec-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      status: "completed",
      resultCount: 5,
    });

    const events = store.listRecallEventsByEpisode("ep-1");
    expect(events).toHaveLength(3);
    // 按 id 升序
    expect(events[0]?.status).toBe("started");
    expect(events[1]?.layer).toBe("facts");
    expect(events[2]?.status).toBe("completed");

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryJournalStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryJournalStore", () => {
  it("appendIntent creates a pending intent", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    const intent = store.appendIntent({
      id: "j-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: { fact: "测试事实" },
    });

    expect(intent.id).toBe("j-1");
    expect(intent.status).toBe("pending");
    expect(intent.payload).toEqual({ fact: "测试事实" });

    closeAndCleanup(database);
  });

  it("appendSystemIntent allows custom initial status", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    const intent = store.appendSystemIntent({
      id: "j-pin-1",
      agentId: "agent-1",
      actor: "system",
      intentType: "pin",
      targetType: "memory",
      payload: { content: "置顶内容" },
      status: "applied",
      appliedAt: "2026-07-31T10:00:00.000Z",
    });

    expect(intent.status).toBe("applied");
    expect(intent.appliedAt).toBe("2026-07-31T10:00:00.000Z");

    closeAndCleanup(database);
  });

  it("listPending returns only pending intents", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    store.appendIntent({
      id: "j-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: {},
    });

    store.appendSystemIntent({
      id: "j-2",
      agentId: "agent-1",
      actor: "system",
      intentType: "pin",
      targetType: "memory",
      payload: {},
      status: "applied",
    });

    const pending = store.listPending("agent-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("j-1");

    closeAndCleanup(database);
  });

  it("listByAgent filters by status and intentType", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    store.appendIntent({
      id: "j-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: {},
    });
    store.appendIntent({
      id: "j-2",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "forget",
      targetType: "event",
      payload: {},
    });

    const forgetOnly = store.listByAgent("agent-1", {
      intentType: "forget",
    });
    expect(forgetOnly).toHaveLength(1);
    expect(forgetOnly[0]?.id).toBe("j-2");

    closeAndCleanup(database);
  });

  it("markStatus transitions status and sets appliedAt", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    store.appendIntent({
      id: "j-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: {},
    });

    const applied = store.markStatus("j-1", "applied");
    expect(applied.status).toBe("applied");
    expect(applied.appliedAt).toBeDefined();

    const revoked = store.markStatus("j-1", "revoked");
    expect(revoked.status).toBe("revoked");
    expect(revoked.appliedAt).toBeUndefined();

    closeAndCleanup(database);
  });

  it("markStatus throws for missing intent", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    expect(() => store.markStatus("nonexistent", "approved")).toThrow(
      /记忆意图不存在/,
    );

    closeAndCleanup(database);
  });

  it("is append-only: no payload modification methods exist", () => {
    // 验证 journal store 没有 updatePayload/modifyPayload 等方法
    // 这是一个编译时检查，运行时验证实例上没有此类方法
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    const forbidden = [
      "updatePayload",
      "modifyPayload",
      "update",
      "setPayload",
      "edit",
    ];
    const s = store as unknown as Record<string, unknown>;
    for (const method of forbidden) {
      expect(typeof s[method]).toBe("undefined");
    }

    closeAndCleanup(database);
  });

  it("listSuppressions returns applied suppress/forget intents", () => {
    const { database } = createContext();
    const store = new MemoryJournalStore(database);

    // 添加 suppress intent 并标记为 applied
    store.appendIntent({
      id: "j-sup-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "suppress",
      targetType: "fact",
      payload: { reason: "过期" },
    });
    store.markStatus("j-sup-1", "applied");

    // 添加 forget intent（pending，不应出现在 suppressions 中）
    store.appendIntent({
      id: "j-for-1",
      agentId: "agent-1",
      actor: "user",
      intentType: "forget",
      targetType: "fact",
      payload: {},
    });

    // 添加 remember intent（不相关）
    store.appendIntent({
      id: "j-rem-1",
      agentId: "agent-1",
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: {},
    });
    store.markStatus("j-rem-1", "applied");

    const suppressions = store.listSuppressions("agent-1");
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]?.id).toBe("j-sup-1");
    expect(suppressions[0]?.intentType).toBe("suppress");

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryBatchStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryBatchStore", () => {
  it("creates a batch with given status", () => {
    const { database } = createContext();
    const store = new MemoryBatchStore(database);

    const batch = store.createBatch(
      {
        id: "batch-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: { summaryRev: "v1" },
        priority: 10,
      },
      "sealed",
    );

    expect(batch.id).toBe("batch-1");
    expect(batch.status).toBe("sealed");
    expect(batch.priority).toBe(10);
    expect(batch.revision).toEqual({ summaryRev: "v1" });

    closeAndCleanup(database);
  });

  it("listPendingBatches returns correct statuses ordered by priority DESC, created_at ASC", () => {
    const { database } = createContext();
    const store = new MemoryBatchStore(database);

    store.createBatch(
      {
        id: "b-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 5,
      },
      "sealed",
    );
    store.createBatch(
      {
        id: "b-2",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 10,
      },
      "provisional",
    );
    const b3 = store.createBatch(
      {
        id: "b-3",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 3,
      },
      "sealed",
    );
    store.markStatus(b3.id, "deferred");

    const pending = store.listPendingBatches("agent-1");
    // priority DESC (10, 5, 3), then created_at ASC
    expect(pending).toHaveLength(3);
    expect(pending[0]?.priority).toBe(10);
    expect(pending[1]?.priority).toBe(5);
    expect(pending[2]?.priority).toBe(3);

    closeAndCleanup(database);
  });

  it("listPendingBatches excludes processing and applied", () => {
    const { database } = createContext();
    const store = new MemoryBatchStore(database);

    store.createBatch(
      {
        id: "b-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 1,
      },
      "sealed",
    );
    store.createBatch(
      {
        id: "b-2",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 2,
      },
      "sealed",
    );
    store.markStatus("b-2", "applied");

    const pending = store.listPendingBatches("agent-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("b-1");

    closeAndCleanup(database);
  });

  it("markStatus updates status and throws for missing", () => {
    const { database } = createContext();
    const store = new MemoryBatchStore(database);

    store.createBatch(
      {
        id: "b-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 1,
      },
      "sealed",
    );
    const updated = store.markStatus("b-1", "processing");
    expect(updated.status).toBe("processing");

    expect(() => store.markStatus("nonexistent", "applied")).toThrow(
      /封存批次不存在/,
    );

    closeAndCleanup(database);
  });

  it("listByAgent filters by status", () => {
    const { database } = createContext();
    const store = new MemoryBatchStore(database);

    store.createBatch(
      {
        id: "b-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 1,
      },
      "sealed",
    );
    store.createBatch(
      {
        id: "b-2",
        agentId: "agent-1",
        sessionId: "sess-1",
        revision: {},
        priority: 1,
      },
      "sealed",
    );
    store.markStatus("b-2", "applied");

    const sealed = store.listByAgent("agent-1", { status: "sealed" });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.id).toBe("b-1");

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryDailyStateStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryDailyStateStore", () => {
  it("markStepDone is idempotent", () => {
    const { database } = createContext();
    const store = new MemoryDailyStateStore(database);

    store.markStepDone("agent-1", "2026-07-31", "S0");
    store.markStepDone("agent-1", "2026-07-31", "S0"); // 重复标记

    const steps = store.listDoneSteps("agent-1", "2026-07-31");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBe("S0");

    closeAndCleanup(database);
  });

  it("isStepDone returns correct boolean", () => {
    const { database } = createContext();
    const store = new MemoryDailyStateStore(database);

    expect(store.isStepDone("agent-1", "2026-07-31", "S1")).toBe(false);

    store.markStepDone("agent-1", "2026-07-31", "S1");
    expect(store.isStepDone("agent-1", "2026-07-31", "S1")).toBe(true);

    closeAndCleanup(database);
  });

  it("listDoneSteps returns all steps for a date", () => {
    const { database } = createContext();
    const store = new MemoryDailyStateStore(database);

    store.markStepDone("agent-1", "2026-07-31", "S0");
    store.markStepDone("agent-1", "2026-07-31", "S2");
    store.markStepDone("agent-1", "2026-07-31", "S4");

    const steps = store.listDoneSteps("agent-1", "2026-07-31");
    expect(steps).toHaveLength(3);
    expect(steps).toContain("S0");
    expect(steps).toContain("S2");
    expect(steps).toContain("S4");

    // 不同日期隔离
    expect(store.listDoneSteps("agent-1", "2026-08-01")).toHaveLength(0);

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryWatermarkStore
// ═══════════════════════════════════════════════════════════════════
describe("MemoryWatermarkStore", () => {
  it("upserts and retrieves watermarks", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    store.upsert("agent-1", "summary", "br-1", { lastEntry: "e5" }, false);

    const wm = store.get("agent-1", "summary", "br-1");
    expect(wm).toBeDefined();
    expect(wm?.cursor).toEqual({ lastEntry: "e5" });
    expect(wm?.dirty).toBe(false);

    closeAndCleanup(database);
  });

  it("upsert overwrites existing watermark", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    store.upsert("agent-1", "summary", "br-1", { v: 1 }, false);
    store.upsert("agent-1", "summary", "br-1", { v: 2 }, true);

    const wm = store.get("agent-1", "summary", "br-1");
    expect(wm?.cursor).toEqual({ v: 2 });
    expect(wm?.dirty).toBe(true);

    closeAndCleanup(database);
  });

  it("markDirty sets dirty flag", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    store.upsert("agent-1", "events", "br-1", {}, false);
    const updated = store.markDirty("agent-1", "events", "br-1");
    expect(updated.dirty).toBe(true);

    closeAndCleanup(database);
  });

  it("markDirty throws for missing watermark", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    expect(() =>
      store.markDirty("agent-1", "summary", "br-nonexistent"),
    ).toThrow(/水位线不存在/);

    closeAndCleanup(database);
  });

  it("listDirty returns only dirty watermarks", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    store.upsert("agent-1", "summary", "br-1", {}, false);
    store.upsert("agent-1", "events", "br-1", {}, true);
    store.upsert("agent-1", "markdown", "br-1", {}, true);

    const dirty = store.listDirty("agent-1");
    expect(dirty).toHaveLength(2);
    const scopes = dirty.map((w) => w.scope);
    expect(scopes).toContain("events");
    expect(scopes).toContain("markdown");
    expect(scopes).not.toContain("summary");

    closeAndCleanup(database);
  });

  it("watermarks are scoped by agent", () => {
    const { database } = createContext();
    const store = new MemoryWatermarkStore(database);

    store.upsert("agent-1", "summary", "br-1", {}, true);
    store.upsert("agent-2", "summary", "br-1", {}, false);

    expect(store.listDirty("agent-1")).toHaveLength(1);
    expect(store.listDirty("agent-2")).toHaveLength(0);

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SchedulerStateStore
// ═══════════════════════════════════════════════════════════════════
describe("SchedulerStateStore", () => {
  it("upserts and retrieves scheduler state", () => {
    const { database } = createContext();
    const store = new SchedulerStateStore(database);

    store.upsert({
      agentId: "agent-1",
      status: "idle",
      lastDailyDate: "2026-07-31",
      lastDailyCompletedAt: "2026-07-31T03:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    const state = store.get("agent-1");
    expect(state).toBeDefined();
    expect(state?.status).toBe("idle");
    expect(state?.lastDailyDate).toBe("2026-07-31");

    closeAndCleanup(database);
  });

  it("upsert overwrites existing state", () => {
    const { database } = createContext();
    const store = new SchedulerStateStore(database);

    store.upsert({
      agentId: "agent-1",
      status: "idle",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    store.upsert({
      agentId: "agent-1",
      status: "running",
      nextRetryAt: "2026-07-31T05:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    const state = store.get("agent-1");
    expect(state?.status).toBe("running");
    expect(state?.nextRetryAt).toBe("2026-07-31T05:00:00.000Z");

    closeAndCleanup(database);
  });

  it("returns undefined for unknown agent", () => {
    const { database } = createContext();
    const store = new SchedulerStateStore(database);

    expect(store.get("nonexistent")).toBeUndefined();

    closeAndCleanup(database);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PinnedMemoryStore
// ═══════════════════════════════════════════════════════════════════
describe("PinnedMemoryStore", () => {
  it("adds and retrieves a pinned memory", () => {
    const { database } = createContext();
    const store = new PinnedMemoryStore(database);

    const pinned = store.add({
      id: "pin-1",
      agentId: "agent-1",
      content: "重要提醒：用户偏好深色模式",
    });

    expect(pinned.id).toBe("pin-1");
    expect(pinned.agentId).toBe("agent-1");
    expect(pinned.content).toBe("重要提醒：用户偏好深色模式");
    expect(pinned.createdAt).toBeDefined();

    closeAndCleanup(database);
  });

  it("listByAgent returns pinned items in created_at ASC order", () => {
    const { database } = createContext();
    const store = new PinnedMemoryStore(database);

    store.add({ id: "pin-1", agentId: "agent-1", content: "第一条" });
    store.add({ id: "pin-2", agentId: "agent-1", content: "第二条" });
    store.add({ id: "pin-3", agentId: "agent-2", content: "其他 Agent" });

    const list = store.listByAgent("agent-1");
    expect(list).toHaveLength(2);
    expect(list[0]?.content).toBe("第一条");
    expect(list[1]?.content).toBe("第二条");

    // Agent 隔离
    expect(store.listByAgent("agent-2")).toHaveLength(1);

    closeAndCleanup(database);
  });

  it("removes a pinned memory", () => {
    const { database } = createContext();
    const store = new PinnedMemoryStore(database);

    store.add({ id: "pin-1", agentId: "agent-1", content: "测试" });
    expect(store.listByAgent("agent-1")).toHaveLength(1);

    store.remove("pin-1");
    expect(store.listByAgent("agent-1")).toHaveLength(0);
    expect(store.get("pin-1")).toBeUndefined();

    closeAndCleanup(database);
  });
});
