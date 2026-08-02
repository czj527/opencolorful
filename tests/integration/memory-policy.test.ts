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
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
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
  // 会话证据验证基线：agent a1 在 session s1 有一次回忆（session:<id> 证据可验证）
  database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
  `).run(crypto.randomUUID());
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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

    // 账本中出现第二个独立会话（s2，指向该事实）+ 两日期 + 高置信度 → 放行
    insertRecall.run(crypto.randomUUID(), String(fact.id), "2026-07-03T10:00:00.000Z");
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's2', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `).run(crypto.randomUUID(), String(fact.id), "2026-07-03T12:00:00.000Z");
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

  it("隐式水位线：提案生成后出现用户 intent → 拒绝；生成前已存在 → 放行", () => {
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
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    // 用户 intent 的 createdAt 晚于提案 createdAt（makeProposal 默认 2026-08-01T00:00:00Z）→ 拒绝
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 50 },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("新的用户意图");

    // 提案生成前已存在的 intent（createdAt 早于提案）→ 放行：
    // intent 的 createdAt 是真实 now，提案用相对时间 now+60s 保证恒晚于 intent
    const older = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 50 },
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(older.approved).toBe(true);
  });

  it("forget 缺少理由 → 拒绝；restore 仅限 forgotten 事实", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
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

describe("MemoryPolicy 迟滞接线（评审 P1-3）", () => {
  it("strength_change 中期降短期：proposed 不低于 mediumDown → 拒绝（迟滞区间）", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    // 默认阈值 mediumUp=45 / mediumDown=35：50 属中期，降到 36 仍在迟滞区间（≥35）→ 拒绝
    const fact = factStore.createFact({
      agentId: "a1", fact: "迟滞事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 36 },
      previousState: { retentionStrength: 50 },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("迟滞");
    // 低于 mediumDown（34）→ 允许降档
    const ok = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 34 },
      previousState: { retentionStrength: 50 },
    }));
    expect(ok.approved).toBe(true);
  });
});

describe("MemoryPolicy 自审修复（版本冲突 / session forget）", () => {
  function build(database: import("better-sqlite3").Database) {
    const factStore = new MemoryFactStore(database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    return { factStore, policy };
  }

  it("supersede：previousState 与当前事实不一致 → 版本冲突拒绝", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "旧事实 v1", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    // 提案生成时读到的是 active，但应用时事实已被其他运行遗忘（status 变化 → 版本冲突）
    factStore.markForgotten(fact.id, { reason: "其他运行已处理" });
    const result = policy.check(makeProposal({
      type: "supersede", targetId: String(fact.id),
      payload: { supersededFactId: fact.id, newFact: "新事实", reason: "过时" },
      previousState: { fact: "旧事实 v1", status: "active" },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("版本冲突");
    // previousState 缺失同样拒绝
    const missing = policy.check(makeProposal({
      type: "supersede", targetId: String(fact.id),
      payload: { supersededFactId: fact.id, newFact: "新事实", reason: "过时" },
    }));
    expect(missing.approved).toBe(false);
  });

  it("merge：previousState.facts 快照缺失或不一致 → 版本冲突拒绝", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const a = factStore.createFact({
      agentId: "a1", fact: "重复 A", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 30,
    });
    const b = factStore.createFact({
      agentId: "a1", fact: "重复 B", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 30,
    });
    // 快照正确（含 revision=updatedAt）→ 放行
    const ok = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
      previousState: { facts: [{ id: String(a.id), fact: "重复 A", status: "active", revision: a.updatedAt }, { id: String(b.id), fact: "重复 B", status: "active", revision: b.updatedAt }] },
    }));
    expect(ok.approved).toBe(true);
    // 快照缺失 → 拒绝
    const missing = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
    }));
    expect(missing.approved).toBe(false);
    expect(missing.reason).toContain("版本冲突");
    // 快照与当前不一致（a 已被其他运行遗忘）→ 拒绝
    factStore.markForgotten(a.id, { reason: "其他运行已处理" });
    const stale = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
      previousState: { facts: [{ id: String(a.id), fact: "重复 A", status: "active" }, { id: String(b.id), fact: "重复 B", status: "active" }] },
    }));
    expect(stale.approved).toBe(false);
  });

  it("forget 目标为 session → 拒绝（无实现不得空操作通过）", () => {
    const { database } = createContext();
    const { policy } = build(database);
    const result = policy.check(makeProposal({
      type: "forget", targetType: "session", targetId: "s1",
      payload: { targetType: "session", targetId: "s1", reason: "会话过期" },
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("暂不支持");
  });
});

describe("MemoryPolicy 复审修复（评审 P0/P1#2/P1#6 复现级测试）", () => {
  function build(database: Database.Database) {
    const factStore = new MemoryFactStore(database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    return { factStore, policy };
  }

  function createFact(factStore: MemoryFactStore, fact: string, retentionStrength: number) {
    return factStore.createFact({
      agentId: "a1", fact, tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength,
    });
  }

  it("P0：pi-sdk 的 main_agent 意图同样触发水位线（原只认 user → 不匹配）", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const fact = createFact(factStore, "水位线事实", 50);
    // pi-sdk remember/forget 工具写入 actor=main_agent（memory-tools.ts）
    database.prepare(`
      INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, target_id, payload, priority, status, created_at)
      VALUES (?, 'a1', 'main_agent', 'forget', 'fact', ?, '{}', 0, 'pending', ?)
    `).run(crypto.randomUUID(), String(fact.id), "2026-08-01T12:00:00.000Z");
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 50 },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("新的用户意图");
  });

  it("P0：水位线全量扫描 journal（>50 条时旧的冲突意图不再被 50 条截断漏掉）", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const fact = createFact(factStore, "截断事实", 50);
    const insertIntent = database.prepare(`
      INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, target_id, payload, priority, status, created_at)
      VALUES (?, 'a1', 'user', 'remember', 'fact', ?, '{"fact":"x"}', 0, 'pending', ?)
    `);
    // 60 条 intent 全部晚于提案 createdAt；指向目标事实的那条最早（created_at 最小）。
    // listByAgent 默认 limit 50 且按 created_at DESC → 最早 10 条被截断 → 旧实现漏检。
    for (let i = 0; i < 60; i++) {
      insertIntent.run(crypto.randomUUID(), String(i === 0 ? fact.id : 9999), `2026-08-01T00:00:${String(i + 1).padStart(2, "0")}.000Z`);
    }
    const result = policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 60 },
      previousState: { retentionStrength: 50 },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("新的用户意图");
  });

  it("P0：merge 水位线检查全部目标事实（原只查第一个）", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const a = createFact(factStore, "重复 A", 30);
    const b = createFact(factStore, "重复 B", 30);
    // 用户意图针对第二个目标事实 b，晚于提案 createdAt
    database.prepare(`
      INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, target_id, payload, priority, status, created_at)
      VALUES (?, 'a1', 'user', 'forget', 'fact', ?, '{"reason":"过时"}', 0, 'pending', ?)
    `).run(crypto.randomUUID(), String(b.id), "2026-08-01T12:00:00.000Z");
    const result = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
      previousState: { facts: [{ id: String(a.id), fact: "重复 A", status: "active", revision: a.updatedAt }, { id: String(b.id), fact: "重复 B", status: "active", revision: b.updatedAt }] },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("新的用户意图");
  });

  it("P1#2：supersede revision 变化（fact/status 未变但被提强）→ 版本冲突", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const fact = createFact(factStore, "版本事实", 50);
    // 提案生成时快照的 revision 比当前 updatedAt 早 1 秒（确定性过期，不依赖时钟粒度）
    const snapshotRevision = new Date(Date.parse(fact.updatedAt) - 1_000).toISOString();
    // 提案生成后，另一运行对该事实提强（updatedAt 变化，fact/status 不变）
    factStore.updateRetention(fact.id, 60);
    const result = policy.check(makeProposal({
      type: "supersede", targetId: String(fact.id),
      payload: { supersededFactId: fact.id, newFact: "新事实", reason: "过时" },
      previousState: { fact: "版本事实", status: "active", revision: snapshotRevision },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("版本冲突");
  });

  it("P1#2：merge 快照缺少 revision → 版本冲突；revision 与当前一致 → 放行", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const a = createFact(factStore, "重复 C", 30);
    const b = createFact(factStore, "重复 D", 30);
    // 缺 revision（旧版 snapshot 形状）→ 拒绝
    const missing = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
      previousState: { facts: [{ id: String(a.id), fact: "重复 C", status: "active" }, { id: String(b.id), fact: "重复 D", status: "active" }] },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(missing.approved).toBe(false);
    expect(missing.reason).toContain("版本冲突");
    // revision 与当前 updatedAt 一致 → 放行
    const ok = policy.check(makeProposal({
      type: "merge", targetType: "fact",
      payload: { factIds: [a.id, b.id], mergedFact: "合并事实" },
      previousState: { facts: [{ id: String(a.id), fact: "重复 C", status: "active", revision: a.updatedAt }, { id: String(b.id), fact: "重复 D", status: "active", revision: b.updatedAt }] },
      createdAt: "2026-08-01T00:00:00Z",
    }));
    expect(ok.approved).toBe(true);
  });

  it("P1#6：晋升永久引用 provisional 批次 → 拒绝；引用 sealed 批次 → 放行", () => {
    const { database } = createContext();
    const { factStore, policy } = build(database);
    const fact = createFact(factStore, "候选永久", 70);
    const batchStore = new MemoryBatchStore(database);
    const insertRecall = database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    for (const day of ["2026-07-01", "2026-07-02"]) {
      insertRecall.run(crypto.randomUUID(), String(fact.id), `${day}T10:00:00.000Z`);
    }
    insertRecall.run(crypto.randomUUID(), String(fact.id), "2026-07-03T10:00:00.000Z");
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's2', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `).run(crypto.randomUUID(), String(fact.id), "2026-07-03T12:00:00.000Z");

    const promotion = (evidenceRefs: readonly string[]) => policy.check(makeProposal({
      type: "strength_change",
      targetId: String(fact.id),
      payload: { retentionStrength: 88 },
      previousState: { retentionStrength: 70 },
      evidenceRefs,
      confidence: 0.9,
      createdAt: "2026-08-01T00:00:00Z",
    }));

    // provisional micro-seal（内容未定稿）→ 拒绝
    batchStore.createBatch({
      id: "batch-provisional-1", agentId: "a1", sessionId: "s1",
      revision: {}, priority: 1,
    }, "provisional");
    const rejected = promotion(["batch:batch-provisional-1"]);
    expect(rejected.approved).toBe(false);
    expect(rejected.reason).toContain("未封存");

    // sealed（已定稿）→ 放行
    batchStore.createBatch({
      id: "batch-sealed-1", agentId: "a1", sessionId: "s1",
      revision: {}, priority: 1,
    }, "sealed");
    expect(promotion(["batch:batch-sealed-1"]).approved).toBe(true);
  });
});
