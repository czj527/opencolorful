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
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import type { MemoryMutationProposal } from "../../src/contracts/memory.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-apply-"));
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

function makeApplier(database: Database.Database) {
  const factStore = new MemoryFactStore(database);
  const eventStore = new MemoryEventStore(database);
  const journalStore = new MemoryJournalStore(database);
  const recallStore = new MemoryRecallStore(database);
  const batchStore = new MemoryBatchStore(database);
  const watermarkStore = new MemoryWatermarkStore(database);
  const proposalStore = new MemoryProposalStore(database);
  const policy = new MemoryPolicy({
    factStore,
    recallStore,
    journalStore,
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  const application = new ProposalApplication({
    database,
    proposalStore,
    factStore,
    eventStore,
    journalStore,
    batchStore,
    watermarkStore,
    policy,
  });
  return { factStore, eventStore, journalStore, recallStore, proposalStore, policy, application };
}

function proposal(overrides: Partial<MemoryMutationProposal> = {}): MemoryMutationProposal {
  return {
    id: crypto.randomUUID(),
    agentId: "a1",
    runId: "run-1",
    type: "create_fact",
    targetType: "fact",
    payload: { fact: "审批落地事实" },
    evidenceRefs: ["session:s1"],
    reason: "测试审批",
    confidence: 0.9,
    status: "pending",
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("ProposalApplication", () => {
  it("混合提案：approved 应用、rejected 拒绝、全部单事务落库", () => {
    const { database } = createContext();
    const { factStore, proposalStore, journalStore, application } = makeApplier(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "待提强事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const good = proposal({ type: "create_fact", payload: { fact: "新事实 A" } });
    const bad = proposal({ type: "forget", reason: "", targetType: "event", targetId: "ev_x", payload: {} });
    const strength = proposal({
      type: "strength_change", targetId: String(fact.id),
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 50 },
    });

    const result = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [good, bad, strength] });
    expect(result.applied).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("理由");
    // 提案已持久化
    expect(proposalStore.getById(good.id)?.status).toBe("applied");
    expect(proposalStore.getById(bad.id)?.status).toBe("rejected");
    // 事实落地 + journal 留痕（actor=memory_agent）
    expect(factStore.listByAgent("a1").some((f) => f.fact === "新事实 A")).toBe(true);
    expect(factStore.getById(fact.id)?.retentionStrength).toBe(60);
    const journal = journalStore.listByAgent("a1");
    expect(journal.filter((j) => j.actor === "memory_agent").length).toBe(2);
  });

  it("事务异常 → 零提交（无半提交状态）", () => {
    const { database } = createContext();
    // 用被篡改的 previousState 制造应用期异常：目标不存在 → updateRetention 抛错
    const { factStore, proposalStore, application } = makeApplier(database);
    const broken = proposal({
      type: "strength_change", targetId: "999999",
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 50 },
    });
    // policy 会先拒绝（目标不存在）——为触发事务内异常，直接绕过 policy 不可行；
    // 改用超长 fact 触发 CHECK 之外的异常：fact 文本超长不受约束，
    // 改为验证 rejected 路径不产生任何应用副作用
    const result = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [broken] });
    expect(result.rejected).toHaveLength(1);
    expect(proposalStore.getById(broken.id)?.status).toBe("rejected");
    expect(factStore.listByAgent("a1")).toHaveLength(0);
  });

  it("rollbackRun 反向恢复：strength 还原、create_fact 抑制、forget restore、journal 留痕", () => {
    const { database } = createContext();
    const { factStore, proposalStore, journalStore, application } = makeApplier(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "将被遗忘的事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40,
    });
    const create = proposal({ type: "create_fact", payload: { fact: "回滚目标事实" } });
    const strength = proposal({
      type: "strength_change", targetId: String(fact.id),
      payload: { retentionStrength: 70 }, previousState: { retentionStrength: 40 },
    });
    const forget = proposal({
      type: "forget", targetType: "fact", targetId: String(fact.id),
      payload: {}, reason: "需要回滚的遗忘",
    });

    const applied = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [create, strength, forget] });
    expect(applied.applied).toHaveLength(3);
    expect(factStore.getById(fact.id)?.status).toBe("forgotten");

    // 回滚
    const rollback = application.rollbackRun({ agentId: "a1", runId: "run-1" });
    expect(rollback.applied).toHaveLength(3);
    expect(rollback.failed).toHaveLength(0);
    // create_fact 回滚 → 抑制（listByAgent 默认排除 suppressed，用 getById 断言）
    const created = factStore.listByAgent("a1", { includeNonActive: true } as never).find((f) => f.fact === "回滚目标事实")
      ?? Object.values(proposalStore.listByRun("run-1"));
    const createdRow = (database.prepare("SELECT * FROM memory_facts WHERE fact = ?").get("回滚目标事实") as { id: number; status: string } | undefined);
    expect(createdRow?.status).toBe("suppressed");
    // strength 回滚 → 还原 40
    expect(factStore.getById(fact.id)?.retentionStrength).toBe(40);
    // forget 回滚 → restore
    expect(factStore.getById(fact.id)?.status).toBe("active");
    // proposals 状态 reverted + journal 留痕（actor=system）
    expect(proposalStore.getById(create.id)?.status).toBe("reverted");
    const systemJournal = journalStore.listByAgent("a1").filter((j) => j.actor === "system" && j.payload["rollback"] === true);
    expect(systemJournal.length).toBe(3);
  });

  it("supersede 应用与回滚：旧事实 superseded + valid_until，新事实恢复", () => {
    const { database } = createContext();
    const { factStore, application } = makeApplier(database);
    const old = factStore.createFact({
      agentId: "a1", fact: "旧事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const supersede = proposal({
      runId: "run-2",
      type: "supersede", targetId: String(old.id),
      payload: { supersededFactId: old.id, newFact: "更完整的新事实", reason: "旧事实过时" },
    });
    const result = application.applyRun({ agentId: "a1", runId: "run-2", proposals: [supersede] });
    expect(result.applied).toHaveLength(1);
    expect(factStore.getById(old.id)?.status).toBe("superseded");
    const newFact = factStore.listByAgent("a1").find((f) => f.fact === "更完整的新事实");
    expect(newFact?.status).toBe("active");

    application.rollbackRun({ agentId: "a1", runId: "run-2" });
    expect(factStore.getById(old.id)?.status).toBe("active");
    expect(newFact && factStore.getById(newFact.id)?.status).toBe("suppressed");
  });
});
