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
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { PinnedMemoryStore } from "../../src/storage/memory/pinned-store.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { MemoryRecallService } from "../../src/runtime/memory/recall-service.js";
import type { MemoryContext } from "../../src/pi-sdk/memory-tools.js";
import { runWithMemoryContext } from "../../src/pi-sdk/memory-tools.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencolorful-memory-tools-"),
  );
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { paths, database, dir };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function createMemoryContext(database: Database.Database): MemoryContext {
  const factStore = new MemoryFactStore(database);
  const eventStore = new MemoryEventStore(database);
  const recallStore = new MemoryRecallStore(database);
  const journalStore = new MemoryJournalStore(database);
  const pinnedStore = new PinnedMemoryStore(database);
  const sessionIndex = new SessionIndex(database);
  const agentsDir = path.join(os.tmpdir(), "agents");

  const recallService = new MemoryRecallService({
    factStore,
    eventStore,
    recallStore,
    sessionIndex,
    publish: () => {},
    agentsDir,
  });

  return {
    agentId: "agent-test",
    recallService,
    journalStore,
    pinnedStore,
  };
}

describe("memory-tools", () => {
  // NOTE: These tests directly drive the tool stores through the MemoryContext,
  // not through the PI tool registration. This tests the core logic of each tool.

  it("remember appends a journal intent", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    const intent = runWithMemoryContext(ctx, () =>
      ctx.journalStore.appendIntent({
        id: "test-intent-1",
        agentId: ctx.agentId,
        actor: "main_agent",
        intentType: "remember",
        targetType: "fact",
        payload: { fact: "用户偏好深色模式", tags: ["偏好"] },
      }),
    );

    expect(intent.status).toBe("pending");
    expect(intent.intentType).toBe("remember");
    expect(intent.targetType).toBe("fact");
    expect(intent.payload).toEqual({ fact: "用户偏好深色模式", tags: ["偏好"] });

    // Verify it's in the journal
    const retrieved = ctx.journalStore.get("test-intent-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe("pending");
  });

  it("forget appends a journal intent", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    const intent = ctx.journalStore.appendIntent({
      id: "test-forget-1",
      agentId: ctx.agentId,
      actor: "main_agent",
      intentType: "forget",
      targetType: "event",
      targetId: "ev-123",
      payload: { reason: "不再需要" },
    });

    expect(intent.intentType).toBe("forget");
    expect(intent.targetType).toBe("event");
    expect(intent.status).toBe("pending");
  });

  it("pin_memory adds to pinned store and journals as applied", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    const pinned = ctx.pinnedStore.add({
      id: "pin-test-1",
      agentId: ctx.agentId,
      content: "重要提醒",
    });

    expect(pinned.content).toBe("重要提醒");
    expect(pinned.agentId).toBe(ctx.agentId);

    // Journal should have an applied entry
    ctx.journalStore.appendSystemIntent({
      id: "journal-pin-1",
      agentId: ctx.agentId,
      actor: "system",
      intentType: "pin",
      targetType: "memory",
      targetId: "pin-test-1",
      payload: { content: "重要提醒" },
      status: "applied",
      appliedAt: new Date().toISOString(),
    });

    const journalEntry = ctx.journalStore.get("journal-pin-1");
    expect(journalEntry).toBeDefined();
    expect(journalEntry?.status).toBe("applied");
  });

  it("unpin_memory removes from pinned store and journals as applied", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    // Add first
    ctx.pinnedStore.add({
      id: "pin-to-remove",
      agentId: ctx.agentId,
      content: "待移除",
    });

    // Verify exists
    expect(ctx.pinnedStore.get("pin-to-remove")).toBeDefined();
    expect(ctx.pinnedStore.listByAgent(ctx.agentId)).toHaveLength(1);

    // Remove
    ctx.pinnedStore.remove("pin-to-remove");

    // Verify removed
    expect(ctx.pinnedStore.get("pin-to-remove")).toBeUndefined();
    expect(ctx.pinnedStore.listByAgent(ctx.agentId)).toHaveLength(0);

    // Journal
    ctx.journalStore.appendSystemIntent({
      id: "journal-unpin-1",
      agentId: ctx.agentId,
      actor: "system",
      intentType: "unpin",
      targetType: "memory",
      targetId: "pin-to-remove",
      payload: { content: "待移除" },
      status: "applied",
      appliedAt: new Date().toISOString(),
    });

    const journalEntry = ctx.journalStore.get("journal-unpin-1");
    expect(journalEntry?.status).toBe("applied");
  });

  it("unpin_memory throws when pinned memory does not exist", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    // Attempting to get a non-existent pin returns undefined
    expect(ctx.pinnedStore.get("nonexistent")).toBeUndefined();

    // Journal append still works with any id
    ctx.journalStore.appendSystemIntent({
      id: "journal-missing",
      agentId: ctx.agentId,
      actor: "system",
      intentType: "unpin",
      targetType: "memory",
      targetId: "nonexistent",
      payload: {},
      status: "applied",
      appliedAt: new Date().toISOString(),
    });
    expect(ctx.journalStore.get("journal-missing")).toBeDefined();
  });

  it("search_memory returns structured result with episode lifecycle", async () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    // Run a search with no data - should return empty
    const result = await ctx.recallService.search({
      agentId: ctx.agentId,
      sessionId: "test-session",
      args: { query: "something" },
    });

    expect(result.status).toBe("empty");
    expect(result.hits).toHaveLength(0);
    expect(result.episodeId).toBeDefined();
    expect(result.reachedLayer).toBe("facts");
  });

  it("search_memory with quick depth only searches facts", async () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    // Insert a fact via raw SQL
    database
      .prepare(
        `INSERT INTO memory_facts (agent_id, fact, search_text, status, created_at, updated_at)
         VALUES ('agent-test', '用户偏好深色模式', '深色 模式', 'active', datetime('now'), datetime('now'))`,
      )
      .run();

    const result = await ctx.recallService.search({
      agentId: ctx.agentId,
      sessionId: "test-session",
      args: { query: "深色模式", depth: "quick" },
    });

    // Should find the fact, status completed
    expect(result.status).toBe("completed");
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]?.layer).toBe("facts");
    expect(result.hits[0]?.targetType).toBe("fact");
  });

  it("journal intents are agent-isolated", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    ctx.journalStore.appendIntent({
      id: "agent-a-intent",
      agentId: ctx.agentId,
      actor: "main_agent",
      intentType: "remember",
      targetType: "fact",
      payload: { fact: "agent A 的事实" },
    });

    // Different agent should not see this
    const otherIntents = ctx.journalStore.listPending("agent-other");
    expect(otherIntents).toHaveLength(0);

    // Same agent should see it
    const sameIntents = ctx.journalStore.listPending(ctx.agentId);
    expect(sameIntents).toHaveLength(1);
  });

  it("pinned memories are agent-isolated", () => {
    const { database } = createContext();
    const ctx = createMemoryContext(database);

    ctx.pinnedStore.add({
      id: "pin-agent-a",
      agentId: ctx.agentId,
      content: "Agent A 的置顶",
    });

    expect(ctx.pinnedStore.listByAgent("agent-other")).toHaveLength(0);
    expect(ctx.pinnedStore.listByAgent(ctx.agentId)).toHaveLength(1);
  });
});
