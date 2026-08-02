import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryWatermarkStore, SchedulerStateStore } from "../../src/storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ActivationUpdater } from "../../src/runtime/memory/activation-updater.js";
import { MemoryAgentResolver } from "../../src/runtime/memory/resolver.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-resolver-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  // 会话证据验证基线：agent a1 在 session s1 有一次回忆
  database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
  `).run(crypto.randomUUID());
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
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

type CompleteText = (agentId: string, req: { systemPrompt: string; prompt: string; maxTokens?: number }) => Promise<string>;

function buildResolver(
  database: Database.Database,
  agentsDir: string,
  completeText: CompleteText,
  limits?: { maxIterations?: number; maxTokens?: number; maxMinutes?: number },
) {
  const factStore = new MemoryFactStore(database);
  const eventStore = new MemoryEventStore(database);
  const journalStore = new MemoryJournalStore(database);
  const recallStore = new MemoryRecallStore(database);
  const batchStore = new MemoryBatchStore(database);
  const watermarkStore = new MemoryWatermarkStore(database);
  const summaryStore = new SessionSummaryStore(database);
  const proposalStore = new MemoryProposalStore(database);
  const policy = new MemoryPolicy({
    factStore, recallStore, journalStore,
    batchStore, eventStore,
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  const application = new ProposalApplication({
    database, proposalStore, factStore, eventStore, journalStore, batchStore, watermarkStore, policy,
    audit: new AuditRecorder({ database, producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" } }),
  });
  const activationUpdater = new ActivationUpdater({ database, factStore, recallStore });
  const envelopes: PlatformEventEnvelope[] = [];
  const resolver = new MemoryAgentResolver({
    batchStore, journalStore, factStore, eventStore, recallStore, proposalStore, watermarkStore, summaryStore,
    application,
    settingsResolver: () => ({ ...defaultMemoryAgentSettings(), deepDiveMode: "experimental-agent" }),
    completeText,
    sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
    agentsDir,
    publish: (env) => envelopes.push(env),
    activationUpdater,
    ...(limits !== undefined ? { limits } : {}),
    now: () => new Date("2026-08-01T12:00:00Z"),
  });
  return { factStore, journalStore, batchStore, watermarkStore, proposalStore, resolver, envelopes };
}

describe("MemoryAgentResolver", () => {
  it("完整维护：提案应用、批次 applied、意图结算、SSE completed、markdown dirty", async () => {
    const { database, agentsDir } = createContext();
    // 假模型：先 propose_fact（匹配意图文本）再 final
    let script = [
      JSON.stringify({ kind: "tool_call", tool: "propose_fact", args: { payload: { fact: "用户要求记住的事实" }, evidenceRefs: ["session:s1"], reason: "用户意图", confidence: 0.95 } }),
      JSON.stringify({ kind: "final", report: { summary: "完成" } }),
    ].join("\n");
    const { factStore, journalStore, batchStore, watermarkStore, resolver, envelopes } = buildResolver(
      database, agentsDir,
      async (_agentId: string) => {
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
    );
    batchStore.createBatch({
      id: "b1", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const intent = journalStore.appendIntent({
      id: "int-1", agentId: "a1", actor: "user", intentType: "remember",
      targetType: "fact", payload: { fact: "用户要求记住的事实" },
    });

    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.applied).toBe(1);
    expect(batchStore.get("b1")?.status).toBe("applied");
    expect(journalStore.get(intent.id)?.status).toBe("applied");
    expect(factStore.listByAgent("a1").some((f) => f.fact === "用户要求记住的事实")).toBe(true);
    expect(watermarkStore.listDirty("a1").some((w) => w.scope === "markdown")).toBe(true);
    const types = envelopes.map((e) => e.type);
    expect(types).toContain("memory.agent.started");
    expect(types).toContain("memory.agent.completed");
  });

  it("deferred（预算熔断）：批次标记 deferred、SSE deferred、不应用", async () => {
    const { database, agentsDir } = createContext();
    const { batchStore, resolver, envelopes } = buildResolver(
      database, agentsDir,
      async () => JSON.stringify({ kind: "final", report: { summary: "x" } }),
      { maxIterations: 0 },
    );
    batchStore.createBatch({
      id: "b2", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("deferred");
    expect(batchStore.get("b2")?.status).toBe("deferred");
    expect(envelopes.some((e) => e.type === "memory.agent.deferred")).toBe(true);
  });

  it("模型失败 → memory.agent.failed，批次保留 pending", async () => {
    const { database, agentsDir } = createContext();
    const { batchStore, resolver, envelopes } = buildResolver(
      database, agentsDir,
      async (_agentId: string) => { throw new Error("模型不可用"); },
    );
    batchStore.createBatch({
      id: "b3", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("failed");
    expect(batchStore.get("b3")?.status).toBe("sealed");
    expect(envelopes.some((e) => e.type === "memory.agent.failed")).toBe(true);
  });

  it("全部提案被策略拒绝 → completed（正常结果），批次保留 sealed 供重算重试（计划 §六）", async () => {
    const { database, agentsDir } = createContext();
    let rejected = false;
    const { batchStore, resolver } = buildResolver(
      database, agentsDir,
      async (_agentId: string) => {
        if (!rejected) {
          rejected = true;
          return JSON.stringify({ kind: "tool_call", tool: "propose_fact", args: { payload: { fact: "无证据事实" }, evidenceRefs: [], reason: "x", confidence: 0.9 } });
        }
        return JSON.stringify({ kind: "final", report: { summary: "结束" } });
      },
    );
    batchStore.createBatch({
      id: "b4", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.rejected).toBe(1);
    expect(outcome.applied).toBe(0);
    // 可恢复拒绝（版本/watermark/证据不足）→ 批次保留，模型可据拒绝原因重新计算（复审 P1-3）
    expect(batchStore.get("b4")?.status).toBe("sealed");
  });
});

describe("MemoryAgentResolver 验收修复（评审 P2-7）", () => {
  it("应用 strength_change → 发布 memory.strength.changed（含前后强度）", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "强度事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    let proposed = true;
    const { batchStore, resolver, envelopes } = buildResolver(
      database, agentsDir,
      async (_agentId: string) => {
        if (proposed) {
          proposed = false;
          return JSON.stringify({ kind: "tool_call", tool: "propose_strength_change", args: { memoryId: fact.id, payload: { retentionStrength: 60 }, evidenceRefs: ["session:s1"], reason: "新增回忆证据", confidence: 0.9 } });
        }
        return JSON.stringify({ kind: "final", report: { summary: "完成" } });
      },
    );
    batchStore.createBatch({
      id: "b-s", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.applied).toBe(1);
    const changed = envelopes.filter((e) => e.type === "memory.strength.changed");
    expect(changed).toHaveLength(1);
    const payload = changed[0]?.payload as { factId: number; retentionStrength: number; previousRetention: number };
    expect(payload.factId).toBe(fact.id);
    expect(payload.retentionStrength).toBe(60);
    expect(payload.previousRetention).toBe(50);
  });
});

describe("MemoryAgentResolver deepDiveMode 接线（评审 P0-2）", () => {
  it("script 模式：不调用 LLM，确定性重建 activation，不触碰 sealed batch，落运行报告", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "投影事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50, activationStrength: 0,
    });
    database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', '2026-07-31T10:00:00.000Z')
    `).run(crypto.randomUUID(), String(fact.id));
    let llmCalled = false;
    const { batchStore, resolver } = buildResolver(
      database, agentsDir,
      async (_agentId: string) => { llmCalled = true; return JSON.stringify({ kind: "final", report: { summary: "不应被调用" } }); },
    );
    // 覆盖 settingsResolver 为 script 模式
    (resolver as unknown as { deps: { settingsResolver: () => unknown } }).deps.settingsResolver = () => ({ ...defaultMemoryAgentSettings(), deepDiveMode: "script" });
    batchStore.createBatch({
      id: "b-sc", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
      sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
    }, "sealed");
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.applied).toBe(0);
    expect(llmCalled).toBe(false);
    // sealed batch 未触碰；activation 投影已由账本重建
    expect(batchStore.get("b-sc")?.status).toBe("sealed");
    expect(factStore.getById(fact.id)?.activationStrength).toBeGreaterThan(0);
    // 运行报告落盘（script 模式也有报告）
    const runsDir = path.join(agentsDir, "a1", "memory", "runs");
    expect(fs.existsSync(path.join(runsDir, outcome.runId, "run.json"))).toBe(true);
  });
});
