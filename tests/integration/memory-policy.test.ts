import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import type { MemoryMutationProposal } from "../../src/contracts/memory.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-policy-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { dir, database };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function makeProposal(overrides: Partial<MemoryMutationProposal> = {}): MemoryMutationProposal {
  return {
    id: crypto.randomUUID(),
    agentId: "a1",
    runId: "run-1",
    type: "create_fact",
    targetType: "fact",
    payload: { fact: "新事实" },
    evidenceRefs: ["session:s1"],
    reason: "测试",
    confidence: 0.9,
    status: "pending",
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("MemoryPolicy", () => {
  it("create_fact 缺少理由与证据 → 拒绝", () => {
    const { database } = createContext();
    const policy = new MemoryPolicy({
      factStore: new MemoryFactStore(database),
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({ reason: "", evidenceRefs: [] }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("证据");
  });

  it("create_fact 与 active 事实重复 → 拒绝并建议合并", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    factStore.createFact({
      agentId: "a1", fact: "用户偏好深色模式", tags: [], source: "agent_approved",
      sourceRefs: ["session:seed"], confidence: 0.9, retentionStrength: 40,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({ payload: { fact: "用户偏好深色模式" } }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("重复");
  });

  it("strength_change 版本冲突（previous 与当前不一致）→ 拒绝", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "目标事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 99 }, // 过期版本
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("版本冲突");
  });

  it("permanent 事实不可衰减 → 拒绝", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "永久事实", tags: [], source: "user_intent",
      sourceRefs: ["session:s1"], confidence: 1, retentionStrength: 90,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 90 },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("永久");
  });

  it("跨档跳跃（short→permanent 一步）→ 拒绝", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "短期事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 20,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 90 },
      previousState: { retentionStrength: 20 },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("跨档");
  });

  it("medium→permanent 晋升条件：缺独立会话/日期 → 拒绝；满足 → 放行", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const recallStore = new MemoryRecallStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "候选永久事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 70,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore,
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    // 单会话单日期 → 拒绝
    let result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 88 },
      previousState: { retentionStrength: 70 },
      evidenceRefs: ["session:s1"],
      confidence: 0.9,
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("独立会话");

    // 多日期 ledger 但证据单会话 → 仍拒绝
    // （appendRecall 内部用 now 生成 created_at，这里用 raw SQL 注入历史日期）
    const insertRecall = database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    for (const day of ["2026-07-01", "2026-07-02"]) {
      insertRecall.run(crypto.randomUUID(), String(fact.id), `${day}T10:00:00.000Z`);
    }
    result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 88 },
      previousState: { retentionStrength: 70 },
      evidenceRefs: ["session:s1"],
      confidence: 0.9,
    }));
    expect(result.approved).toBe(false);

    // 两独立会话证据 + 两日期 ledger + 高置信度 → 放行
    result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 88 },
      previousState: { retentionStrength: 70 },
      evidenceRefs: ["session:s1", "session:s2"],
      confidence: 0.9,
    }));
    expect(result.approved).toBe(true);
  });

  it("journal 水位线之后出现用户 intent → 拒绝", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const journalStore = new MemoryJournalStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "水位线事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    journalStore.appendIntent({
      id: crypto.randomUUID(), agentId: "a1", actor: "user",
      intentType: "forget", targetType: "fact", targetId: String(fact.id),
      payload: {},
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore,
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60, journalWatermark: "2026-01-01T00:00:00Z" },
      previousState: { retentionStrength: 50 },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("水位线");
  });

  it("forget 缺少理由 → 拒绝；restore 仅限 forgotten 事实", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    expect(policy.check(makeProposal({ type: "forget", reason: "" })).approved).toBe(false);

    const fact = factStore.createFact({
      agentId: "a1", fact: "可恢复事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40,
    });
    // active 事实不能 restore
    expect(policy.check(makeProposal({
      type: "restore", targetId: String(fact.id), payload: {},
    })).approved).toBe(false);
    factStore.markForgotten(fact.id, { reason: "测试遗忘" });
    expect(policy.check(makeProposal({
      type: "restore", targetId: String(fact.id), payload: {},
    })).approved).toBe(true);
  });
});
