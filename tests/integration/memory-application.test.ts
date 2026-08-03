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
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
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
    batchStore,
    eventStore,
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  // 会话证据验证基线：agent a1 在 session s1 有一次回忆
  database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
  `).run(crypto.randomUUID());
  // 评审 P0（第三轮）：记忆审批/遗忘/强度与事实修改同事务严格审计（fail-closed）
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
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
    audit,
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

  it("事务中途异常 → 整体回滚（无半成品提交）", () => {
    const { database } = createContext();
    const { factStore, proposalStore, journalStore, application } = makeApplier(database);
    // 第一个提案正常（会在事务内先落地），第二个提案制造 CHECK 约束异常：
    // confidence=1.5 违反 memory_facts 的 CHECK（0-1）→ createFact 抛错
    const good = proposal({ type: "create_fact", payload: { fact: "事务内先落地的正常事实" } });
    const broken = proposal({
      type: "create_fact", payload: { fact: "触发约束异常的事实" }, confidence: 1.5,
    });
    expect(() => application.applyRun({ agentId: "a1", runId: "run-1", proposals: [good, broken] })).toThrow();
    // 整个事务回滚：无任何事实、提案、journal 留痕残留
    expect(factStore.listByAgent("a1")).toHaveLength(0);
    expect(proposalStore.getById(good.id)).toBeUndefined();
    expect(proposalStore.getById(broken.id)).toBeUndefined();
    expect(journalStore.listByAgent("a1")).toHaveLength(0);
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
      previousState: { fact: "旧事实", status: "active", revision: old.updatedAt },
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

describe("ProposalApplication 确定性初始强度（评审 P1-3）", () => {
  it("create_fact 缺省 retentionStrength → 按证据/可信度确定性计算（非 0）；匹配 remember 意图 → 用户意图强度", async () => {
    const { database } = createContext();
    const { factStore, journalStore, application } = makeApplier(database);
    const plain = proposal({ type: "create_fact", payload: { fact: "普通新事实" }, evidenceRefs: ["session:s1"], confidence: 0.9 });
    const result = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [plain] });
    expect(result.applied).toHaveLength(1);
    const created = factStore.listByAgent("a1").find((f) => f.fact === "普通新事实");
    expect(created).toBeDefined();
    expect(created!.retentionStrength).toBeGreaterThan(0);

    // 用户显式 remember 意图匹配 → computeRetention(userIntent) 至少 70
    journalStore.appendIntent({
      id: crypto.randomUUID(), agentId: "a1", actor: "user", intentType: "remember",
      targetType: "fact", payload: { fact: "请记住这件重要的事" },
    });
    const user = proposal({ type: "create_fact", payload: { fact: "请记住这件重要的事" }, evidenceRefs: ["session:s1"], confidence: 0.9 });
    const result2 = application.applyRun({ agentId: "a1", runId: "run-2", proposals: [user] });
    expect(result2.applied).toHaveLength(1);
    const remembered = factStore.listByAgent("a1").find((f) => f.fact === "请记住这件重要的事");
    expect(remembered!.retentionStrength).toBeGreaterThanOrEqual(70);
  });
});

describe("ProposalApplication 复审修复（评审 P1#3 复现级测试）", () => {
  it("rollbackRun：event forget 回滚恢复事件为 active（原实现把事件 id 当数字事实 id → 事实不存在: NaN）", () => {
    const { database } = createContext();
    const { factStore, eventStore, proposalStore, journalStore, application } = makeApplier(database);
    const event = eventStore.insertEvent({
      id: "evt-rollback-1", agentId: "a1", sessionId: "s1", branchRevision: "b1",
      date: "2026-07-30", startedAt: "2026-07-30T10:00:00Z", endedAt: "2026-07-30T10:30:00Z",
      summary: "一次对话", topics: [], searchText: "对话", messageCount: 3, toolCalls: 0,
      durationSec: 1800, status: "active",
    });
    expect(event).toBe(true);

    const forgetEvent = proposal({
      runId: "run-ev",
      type: "forget", targetType: "event", targetId: "evt-rollback-1",
      payload: { targetType: "event", targetId: "evt-rollback-1", reason: "过时事件" },
      reason: "过时事件",
    });
    const applied = application.applyRun({ agentId: "a1", runId: "run-ev", proposals: [forgetEvent] });
    expect(applied.applied).toHaveLength(1);
    expect(eventStore.getById("evt-rollback-1")?.status).toBe("forgotten");

    const rollback = application.rollbackRun({ agentId: "a1", runId: "run-ev" });
    expect(rollback.failed).toHaveLength(0);
    expect(rollback.applied).toHaveLength(1);
    expect(eventStore.getById("evt-rollback-1")?.status).toBe("active");
    expect(proposalStore.getById(forgetEvent.id)?.status).toBe("reverted");
    expect(journalStore.listByAgent("a1").filter((j) => j.actor === "system" && j.payload["rollback"] === true).length).toBe(1);
  });

  it("rollbackRun：create_fact 回滚用持久化 createdFactId 定位（>50 条事实时 findCreatedFact 的 50 条限制不再误报）", () => {
    const { database } = createContext();
    const { factStore, application } = makeApplier(database);
    // 先造 60 条无关事实，把目标事实挤到 listByAgent 默认 50 条之外
    for (let i = 0; i < 60; i++) {
      factStore.createFact({
        agentId: "a1", fact: `填充事实 ${i}`, tags: [], source: "agent_approved",
        sourceRefs: ["session:s1"], confidence: 0.5, retentionStrength: 10,
      });
    }
    const target = proposal({
      runId: "run-61",
      type: "create_fact", payload: { fact: "第 61 条目标事实" }, evidenceRefs: ["session:s1"],
    });
    const applied = application.applyRun({ agentId: "a1", runId: "run-61", proposals: [target] });
    expect(applied.applied).toHaveLength(1);
    const createdId = (target.payload as Record<string, unknown>)["createdFactId"];
    expect(typeof createdId).toBe("number");
    const row = database.prepare("SELECT status FROM memory_facts WHERE id = ?").get(createdId as number) as { status: string } | undefined;
    expect(row?.status).toBe("active");

    const rollback = application.rollbackRun({ agentId: "a1", runId: "run-61" });
    expect(rollback.failed).toHaveLength(0);
    const after = database.prepare("SELECT status FROM memory_facts WHERE id = ?").get(createdId as number) as { status: string } | undefined;
    expect(after?.status).toBe("suppressed");
  });
});
