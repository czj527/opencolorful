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
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { MemoryAgentRunner } from "../../src/runtime/memory/agent/memory-agent-runner.js";
import { memoryAgentToolMap, type MemoryToolContext } from "../../src/runtime/memory/agent/memory-agent-tools.js";
import { createPersistentSession } from "../../src/pi-sdk/index.js";

// 验收修复：P0-1 跨 Agent 读写隔离。
// 评审复现场景：Agent A 读取 B 的 sealed batch 原文、A 的提案修改 B 的事实强度。

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-isolation-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, "a2", "sessions"), { recursive: true });
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

/** 为指定 Agent 建真实会话文件，返回 handle.path 与 entry ids */
function createAgentSession(agentsDir: string, agentId: string, sessionId: string) {
  const sessionDir = path.join(agentsDir, agentId, "sessions");
  const handle = createPersistentSession(sessionDir, sessionDir, sessionId);
  handle.appendUserMessage("秘密内容");
  handle.appendAssistantMessage("应答内容");
  handle.persist();
  const { readSessionBranchSnapshot } = { readSessionBranchSnapshot: undefined } as never;
  return handle;
}

function toolContext(database: Database.Database, agentsDir: string, agentId: string): MemoryToolContext {
  return {
    agentId,
    runId: "run-isolation",
    factStore: new MemoryFactStore(database),
    eventStore: new MemoryEventStore(database),
    journalStore: new MemoryJournalStore(database),
    batchStore: new MemoryBatchStore(database),
    recallStore: new MemoryRecallStore(database),
    agentsDir,
    proposals: [],
    assertSessionReadable: (sessionPath, targetAgentId) => {
      const resolved = path.resolve(sessionPath);
      const root = path.resolve(path.join(agentsDir, targetAgentId, "sessions"));
      if (!resolved.startsWith(root + path.sep)) throw new Error("Session 路径不在当前 Agent 的会话目录内");
    },
    now: () => new Date("2026-08-01T12:00:00Z"),
    sessionPathResolver: (sessionId) => path.join(agentsDir, agentId, "sessions", `${sessionId}.jsonl`),
  };
}

describe("跨 Agent 读写隔离（P0-1 验收）", () => {
  it("read_session_entries：Agent A 不能读取 Agent B 的批次", async () => {
    const { database, agentsDir } = createContext();
    const batchStore = new MemoryBatchStore(database);
    batchStore.createBatch({
      id: "bB", agentId: "a2", sessionId: "sB",
      revision: { branchRevision: "br" }, sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    } as never, "sealed");
    const ctx = toolContext(database, agentsDir, "a1");
    const tool = memoryAgentToolMap.get("read_session_entries")!;
    expect(() => tool.execute(ctx, { batchId: "bB" })).toThrow("批次不属于当前 Agent");
  });

  it("read_session_entries：不能读取批次限定之外的会话，也不能超出批次原文范围", async () => {
    const { database, agentsDir } = createContext();
    // 真实会话文件 + entry id
    const sessionDir = path.join(agentsDir, "a1", "sessions");
    const handle = createPersistentSession(sessionDir, sessionDir, "sA");
    handle.appendUserMessage("会话内容一");
    handle.appendAssistantMessage("会话内容二");
    handle.appendUserMessage("会话内容三");
    handle.persist();
    const { readSessionBranchSnapshot, sliceBranchRange } = await import("../../src/runtime/memory/jsonl-branch-reader.js");
    const snapshot = readSessionBranchSnapshot(handle.path)!;
    const ids = snapshot.entries.map((entry) => entry.id);
    const e1 = ids[0] ?? "e1";
    const e2 = ids[1] ?? "e2";
    const e3 = ids[2] ?? "e3";

    const batchStore = new MemoryBatchStore(database);
    batchStore.createBatch({
      id: "bA", agentId: "a1", sessionId: "sA",
      revision: { branchRevision: "br" }, sourceStartEntry: e1, sourceEndEntry: e2, priority: 0,
    }, "sealed");

    const ctx: MemoryToolContext = {
      ...toolContext(database, agentsDir, "a1"),
      batchStore,
      sessionPathResolver: () => handle.path,
    };
    const tool = memoryAgentToolMap.get("read_session_entries")!;
    // 批次内读取（含子范围）正常
    expect(() => tool.execute(ctx, { batchId: "bA" })).not.toThrow();
    expect(() => tool.execute(ctx, { batchId: "bA", sessionId: "sA" })).not.toThrow();
    // 指定其他会话 → 拒绝
    expect(() => tool.execute(ctx, { batchId: "bA", sessionId: "sOther" })).toThrow("仅允许读取批次限定的会话");
    // 子范围超出批次（e1→e3 越过 e2）→ 拒绝
    expect(() => tool.execute(ctx, { batchId: "bA", sourceStartEntry: e1, sourceEndEntry: e3 })).toThrow("原文范围超出批次限定");
  });

  it("提案工具：不能对 Agent B 的事实发起 strength/supersede/merge/forget", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const bFact = factStore.createFact({
      agentId: "a2", fact: "B 的私有事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:sB"], confidence: 0.9, retentionStrength: 50,
    });
    const ctx = toolContext(database, agentsDir, "a1");
    expect(() => memoryAgentToolMap.get("propose_strength_change")!.execute(ctx, {
      memoryId: bFact.id, payload: { retentionStrength: 60 },
      evidenceRefs: ["session:s1"], reason: "越权调整", confidence: 0.9,
    })).toThrow("目标事实不属于当前 Agent");
    expect(() => memoryAgentToolMap.get("propose_supersede")!.execute(ctx, {
      memoryId: bFact.id, payload: { supersededFactId: bFact.id, newFact: "取代 B 的事实" },
      evidenceRefs: ["session:s1"], reason: "越权取代", confidence: 0.9,
    })).toThrow("目标事实不属于当前 Agent");
    expect(() => memoryAgentToolMap.get("propose_merge")!.execute(ctx, {
      payload: { factIds: [bFact.id], mergedFact: "合并产物" },
      evidenceRefs: ["session:s1"], reason: "越权合并", confidence: 0.9,
    })).toThrow("目标事实不属于当前 Agent");
    expect(() => memoryAgentToolMap.get("propose_forget")!.execute(ctx, {
      payload: { targetType: "fact", targetId: String(bFact.id) },
      evidenceRefs: ["session:s1"], reason: "越权遗忘", confidence: 0.9,
    })).toThrow("目标事实不属于当前 Agent");
  });

  it("MemoryPolicy：指向 Agent B 事实的提案被拒绝（agentId 归属校验）", async () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const bFact = factStore.createFact({
      agentId: "a2", fact: "B 的私有事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:sB"], confidence: 0.9, retentionStrength: 50,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    // 会话证据基线（s1 属于 a1）
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run(crypto.randomUUID());
    const result = policy.check({
      id: crypto.randomUUID(), agentId: "a1", runId: "run-1", type: "strength_change",
      targetType: "fact", targetId: String(bFact.id),
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 50 },
      evidenceRefs: ["session:s1"], reason: "越权", confidence: 0.9, status: "pending",
      createdAt: "2026-08-01T00:00:00Z",
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("不属于当前 Agent");
  });

  it("ProposalApplication：跨 Agent 提案在应用层被拦截（防御纵深）", async () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    const bFact = factStore.createFact({
      agentId: "a2", fact: "B 的私有事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:sB"], confidence: 0.9, retentionStrength: 50,
    });
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const application = new ProposalApplication({
      database,
      proposalStore: new MemoryProposalStore(database),
      factStore,
      eventStore: new MemoryEventStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      watermarkStore: new MemoryWatermarkStore(database),
      policy,
    });
    const proposal = {
      id: crypto.randomUUID(), agentId: "a1", runId: "run-1", type: "strength_change",
      targetType: "fact", targetId: String(bFact.id),
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 50 },
      evidenceRefs: ["session:s1"], reason: "越权", confidence: 0.9, status: "pending",
      createdAt: "2026-08-01T00:00:00Z",
    } as const;
    // policy 拒绝 → rejected，且 B 的事实不被触碰
    const result = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [proposal] });
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(factStore.getById(bFact.id)?.retentionStrength).toBe(50);
  });

  it("端到端：Agent A 的整理运行无法把 B 的批次原文带入下一轮 prompt", async () => {
    const { database, agentsDir } = createContext();
    // B 的会话含机密，B 的批次已封存
    const sessionDirB = path.join(agentsDir, "a2", "sessions");
    const handleB = createPersistentSession(sessionDirB, sessionDirB, "sB");
    handleB.appendUserMessage("AGENT_B_PRIVATE_SECRET");
    handleB.appendAssistantMessage("B 的内部应答");
    handleB.persist();
    const { readSessionBranchSnapshot } = await import("../../src/runtime/memory/jsonl-branch-reader.js");
    const snapshotB = readSessionBranchSnapshot(handleB.path)!;
    const batchStore = new MemoryBatchStore(database);
    batchStore.createBatch({
      id: "bB", agentId: "a2", sessionId: "sB",
      revision: { branchRevision: "br" },
      sourceStartEntry: snapshotB.entries[0]!.id, sourceEndEntry: snapshotB.entries[1]!.id,
      priority: 0,
    }, "sealed");

    // A 的模型尝试读取 B 的批次 → 工具抛错，提案为空；B 的机密不出现在任何工具结果中
    const prompts: string[] = [];
    let script = [
      JSON.stringify({ kind: "tool_call", tool: "read_session_entries", args: { batchId: "bB" } }),
      JSON.stringify({ kind: "final", report: { summary: "完成" } }),
    ].join("\n");
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore,
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      recallStore: new MemoryRecallStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      assertSessionReadable: (sessionPath, agentId) => {
        const resolved = path.resolve(sessionPath);
        const root = path.resolve(path.join(agentsDir, agentId, "sessions"));
        if (!resolved.startsWith(root + path.sep)) throw new Error("Session 路径不在当前 Agent 的会话目录内");
      },
      completeText: async (req) => {
        prompts.push(req.prompt);
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
    });
    const result = await runner.run();
    expect(result.status).toBe("completed");
    expect(result.proposals).toHaveLength(0);
    // B 的机密不能进入 A 的任何 prompt（工具结果历史会被回填为失败提示）
    expect(prompts.join("\n")).not.toContain("AGENT_B_PRIVATE_SECRET");
  });
});
describe("复审 P0-1：事件跨 Agent 隔离", () => {
  it("工具层：propose_forget(event) 指向 Agent B 的事件 → 拒绝", () => {
    const { database, agentsDir } = createContext();
    const eventStore = new MemoryEventStore(database);
    eventStore.insertEvent({
      id: "event-b", agentId: "a2", sessionId: "sB", branchRevision: "br",
      sourceStartEntry: "e1", sourceEndEntry: "e2", date: "2026-07-30",
      startedAt: "2026-07-30T10:00:00Z", endedAt: "2026-07-30T10:05:00Z",
      summary: "B 的私有事件", topics: [], searchText: "B 的私有事件",
      messageCount: 2, toolCalls: 0, durationSec: 0, status: "active",
    });
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run(crypto.randomUUID());
    const ctx = toolContext(database, agentsDir, "a1");
    expect(() => memoryAgentToolMap.get("propose_forget")!.execute(ctx, {
      payload: { targetType: "event", targetId: "event-b" },
      evidenceRefs: ["session:s1"], reason: "越权遗忘事件", confidence: 0.9,
    })).toThrow("目标事件不属于当前 Agent");
  });

  it("策略层 + 应用层：forget(event) 跨 Agent → 拒绝且事件状态不变", () => {
    const { database } = createContext();
    const eventStore = new MemoryEventStore(database);
    eventStore.insertEvent({
      id: "event-b", agentId: "a2", sessionId: "sB", branchRevision: "br",
      sourceStartEntry: "e1", sourceEndEntry: "e2", date: "2026-07-30",
      startedAt: "2026-07-30T10:00:00Z", endedAt: "2026-07-30T10:05:00Z",
      summary: "B 的私有事件", topics: [], searchText: "B 的私有事件",
      messageCount: 2, toolCalls: 0, durationSec: 0, status: "active",
    });
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run(crypto.randomUUID());
    const policy = new MemoryPolicy({
      factStore: new MemoryFactStore(database),
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore,
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const proposal = {
      id: crypto.randomUUID(), agentId: "a1", runId: "run-1", type: "forget",
      targetType: "event", targetId: "event-b",
      payload: { targetType: "event", targetId: "event-b", reason: "越权" },
      evidenceRefs: ["session:s1"], reason: "越权遗忘事件", confidence: 0.9,
      status: "pending", createdAt: "2026-08-01T00:00:00Z",
    } as const;
    const check = policy.check(proposal);
    expect(check.approved).toBe(false);
    expect(check.reason).toContain("目标事件不属于当前 Agent");

    const application = new ProposalApplication({
      database,
      proposalStore: new MemoryProposalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore,
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      watermarkStore: new MemoryWatermarkStore(database),
      policy,
    });
    const result = application.applyRun({ agentId: "a1", runId: "run-1", proposals: [proposal] });
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(eventStore.getById("event-b")?.status).toBe("active");
  });
});

describe("复审 P0-2：初始强度不可由模型指定", () => {
  it("工具 schema：create_fact 携带 retentionStrength 额外字段 → validateToolArgs 拒绝", async () => {
    const { validateToolArgs } = await import("../../src/runtime/memory/agent/memory-agent-tools.js");
    expect(validateToolArgs("propose_fact", {
      payload: { fact: "instant permanent", retentionStrength: 100 },
      evidenceRefs: ["session:s1"], reason: "x", confidence: 0.9,
    })).toBe(false);
    expect(validateToolArgs("propose_fact", {
      payload: { fact: "正常事实" },
      evidenceRefs: ["session:s1"], reason: "x", confidence: 0.9,
    })).toBe(true);
    expect(validateToolArgs("propose_supersede", {
      memoryId: 1, payload: { supersededFactId: 1, newFact: "新", reason: "r", retentionStrength: 100 },
      evidenceRefs: ["session:s1"], reason: "x", confidence: 0.9,
    })).toBe(false);
  });

  it("应用层：绕过 schema 传入 retentionStrength=100 仍按确定性计算（不落永久档）", () => {
    const { database } = createContext();
    const factStore = new MemoryFactStore(database);
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run(crypto.randomUUID());
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      eventStore: new MemoryEventStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const applier = new ProposalApplication({
      database,
      proposalStore: new MemoryProposalStore(database),
      factStore,
      eventStore: new MemoryEventStore(database),
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      watermarkStore: new MemoryWatermarkStore(database),
      policy,
    });
    const proposal = {
      id: crypto.randomUUID(), agentId: "a1", runId: "run-1", type: "create_fact",
      targetType: "fact",
      payload: { fact: "instant permanent", retentionStrength: 100 },
      evidenceRefs: ["session:s1"], reason: "x", confidence: 0.9,
      status: "pending", createdAt: "2026-08-01T00:00:00Z",
    } as const;
    const result = applier.applyRun({ agentId: "a1", runId: "run-1", proposals: [proposal] });
    expect(result.applied).toHaveLength(1);
    const created = factStore.listByAgent("a1").find((f) => f.fact === "instant permanent");
    // 确定性计算：会话 1×2 + 可信度 0.9×5 ≈ 7（远低于 permanentUp=85，未落永久档）
    expect(created!.retentionStrength).toBeLessThan(85);
  });

  it("会话证据去重：重复提交同一 session 不虚增 independentSessions", () => {
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
    const deduped = policy.computeInitialRetention({
      id: crypto.randomUUID(), agentId: "a1", runId: "r", type: "create_fact",
      targetType: "fact", payload: { fact: "去重事实" },
      evidenceRefs: ["session:s1", "session:s1", "session:s1"],
      reason: "x", confidence: 0.9, status: "pending", createdAt: "2026-08-01T00:00:00Z",
    } as never);
    expect(deduped).toBeLessThan(10);
  });
});

describe("复审 P1-4：recall ledger 全量聚合不受默认 100 条限制", () => {
  it("超过 100 条 recall 后，最早日期/会话仍进入聚合", () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const recallStore = new MemoryRecallStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "账本全量事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40,
    });
    const insertRecall = database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    for (let i = 0; i < 5; i += 1) {
      insertRecall.run(crypto.randomUUID(), String(fact.id), `2026-01-0${i + 1}T10:00:00.000Z`);
    }
    const insertRecallS2 = database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's2', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    for (let i = 0; i < 115; i += 1) {
      insertRecallS2.run(crypto.randomUUID(), String(fact.id), `2026-07-2${i % 9}T10:00:00.000Z`);
    }
    const ctx: import("../../src/runtime/memory/agent/memory-agent-tools.js").MemoryToolContext = {
      agentId: "a1", runId: "r", factStore, eventStore: new MemoryEventStore(database),
      journalStore: new MemoryJournalStore(database), batchStore: new MemoryBatchStore(database),
      recallStore, agentsDir, proposals: [],
      assertSessionReadable: () => undefined,
      now: () => new Date("2026-08-01T12:00:00Z"),
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
    };
    const tool = memoryAgentToolMap.get("get_activation_summary")!;
    const result = JSON.parse(tool.execute(ctx, { memoryId: fact.id }) as string) as { facts: Array<{ hitDates: number; hitSessions: number }> };
    // 120 条跨 2026-01 与 2026-07：独立日期应含 1 月（若截断为最近 100 条则只剩 7 月 9 个日期）
    expect(result.facts[0]?.hitDates).toBeGreaterThanOrEqual(10);
    expect(result.facts[0]?.hitSessions).toBe(2);
  });
});
