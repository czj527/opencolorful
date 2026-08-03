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
import { SessionIndex } from "../../src/storage/session-index.js";
import { MemoryRecallService } from "../../src/runtime/memory/recall-service.js";
import { ActivationUpdater } from "../../src/runtime/memory/activation-updater.js";
import { computeActivation } from "../../src/runtime/memory/intensity-calculator.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-activation-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
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

function seedFactWithLedger(database: Database.Database, factStore: MemoryFactStore, agentId: string, factText: string, days: readonly string[]) {
  const fact = factStore.createFact({
    agentId, fact: factText, tags: [], source: "agent_approved",
    sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40,
  });
  const insertRecall = database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES (?, 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
  `);
  for (const day of days) {
    insertRecall.run(agentId, crypto.randomUUID(), String(fact.id), `${day}T10:00:00.000Z`);
  }
  return fact;
}

describe("ActivationUpdater", () => {
  it("updateForHits 按独立日期封顶 + 衰减更新投影", () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const recallStore = new MemoryRecallStore(database);
    // 今天命中 3 次（同 1 个独立日期）+ 昨天 1 次 = 2 个独立日期
    const fact = seedFactWithLedger(database, factStore, "a1", "高唤起事实", ["2026-08-01", "2026-08-01", "2026-08-01", "2026-07-31"]);
    const updater = new ActivationUpdater({
      database,
      factStore,
      recallStore,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    updater.updateForHits({ agentId: "a1", targetIds: [String(fact.id)] });
    const updated = factStore.getById(fact.id);
    // 2 独立日期 / 14 封顶 × 衰减（0 天前 → 1.0）= round(100 × 2/14) = 14
    expect(updated?.activationStrength).toBe(14);

    // 与纯函数手算一致
    const manual = computeActivation({
      hitDates: ["2026-08-01T10:00:00.000Z", "2026-07-31T10:00:00.000Z"],
      now: new Date("2026-08-01T12:00:00Z"),
    });
    expect(updated?.activationStrength).toBe(manual);
  });

  it("同一日多次命中只计 1 个独立日期（防反馈循环）", () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const recallStore = new MemoryRecallStore(database);
    const fact = seedFactWithLedger(database, factStore, "a1", "单日刷屏事实", ["2026-08-01", "2026-08-01", "2026-08-01", "2026-08-01", "2026-08-01"]);
    const updater = new ActivationUpdater({
      database, factStore, recallStore,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    updater.updateForHits({ agentId: "a1", targetIds: [String(fact.id)] });
    expect(factStore.getById(fact.id)?.activationStrength).toBe(7); // 1/14 → round(7.14) = 7
  });

  it("rebuildAll 由 ledger 重算全部事实投影", () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const recallStore = new MemoryRecallStore(database);
    const f1 = seedFactWithLedger(database, factStore, "a1", "常被回想", ["2026-08-01", "2026-07-30", "2026-07-20"]);
    const f2 = seedFactWithLedger(database, factStore, "a1", "久未回想", []);
    const updater = new ActivationUpdater({
      database, factStore, recallStore,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    updater.rebuildAll("a1");
    const v1 = factStore.getById(f1.id)?.activationStrength ?? 0;
    const v2 = factStore.getById(f2.id)?.activationStrength ?? 0;
    expect(v1).toBeGreaterThan(0);
    expect(v2).toBe(0);
  });

  it("search_memory 端到端：命中后 activation 投影随 ledger 更新", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const eventStore = new MemoryEventStore(database);
    const recallStore = new MemoryRecallStore(database);
    const sessionIndex = new SessionIndex(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "端到端事实", tags: [],
      source: "agent_approved", sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40,
    });
    const updater = new ActivationUpdater({
      database, factStore, recallStore,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    const service = new MemoryRecallService({
      factStore, eventStore, recallStore, sessionIndex,
      publish: () => {}, agentsDir,
      activationUpdater: updater,
    });
    const result = await service.search({
      agentId: "a1", sessionId: "sess-x",
      args: { query: "端到端事实", depth: "quick" },
    });
    expect(result.status).toBe("completed");
    expect(result.hits.some((h) => h.targetType === "fact")).toBe(true);
    // ledger 有命中行
    expect(recallStore.listByAgent("a1")).toHaveLength(1);
    // 投影已更新（1 独立日期 / 14 × 1.0 → 7）
    expect(factStore.getById(fact.id)?.activationStrength).toBe(7);
  });
});
