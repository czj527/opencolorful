import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { PinnedMemoryStore } from "../../src/storage/memory/pinned-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { MemoryRecallService } from "../../src/runtime/memory/recall-service.js";
import { ActivationUpdater } from "../../src/runtime/memory/activation-updater.js";
import { BackgroundReviewService } from "../../src/runtime/memory/background-review.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { MemoryAgentResolver } from "../../src/runtime/memory/resolver.js";
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

// ═══════════════════════════════════════════════════════════════
// 切片 1.75 T15：记忆激活行为级闭环
//   复盘产出意图 → 每日整理审批应用 → search_memory 召回
// 架构边界：长期事实不自动注入 system prompt，只经 search_memory
// 回想召回；复盘服务只写 journal 意图，不直写 memory_facts。
// ═══════════════════════════════════════════════════════════════

/** 复盘 scripted 输出的事实（user → assistant 对答里的一致内容） */
const BACKGROUND_FACT = "用户偏好项目符号列表格式的回复";

type CompleteTextReq = { systemPrompt: string; prompt: string; maxTokens?: number };

/** 写一个最小可读会话（header + 一轮对答），供复盘服务重放 */
function writeSession(dir: string, sessionId: string): string {
  const sessionPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "以后回复我都用项目符号列表" } }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "好的，记住了。" }] } }),
  ].join("\n") + "\n");
  return sessionPath;
}

function makeView(sessionId: string, sessionPath: string) {
  return {
    id: sessionId, title: "测试", sessionPath,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", archived: false,
    agentId: "a1", toolMode: "off", workspaceCwd: null, workspaceConfirmed: false,
    messages: [], messageEntries: [], model: null,
  };
}

function turnCompleted(sessionId: string, sequence: number): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-${sequence}`,
    sessionId,
    streamId: `stream-${sessionId}`,
    sequence,
    timestamp: new Date().toISOString(),
    type: "turn.completed",
    payload: { turnId: `turn-${sequence}` },
  };
}

interface ClosedLoopScene {
  replayStore: EventReplayStore;
  journalStore: MemoryJournalStore;
  factStore: MemoryFactStore;
  batchStore: MemoryBatchStore;
  recallStore: MemoryRecallStore;
  proposalStore: MemoryProposalStore;
  watermarkStore: MemoryWatermarkStore;
  reviewService: BackgroundReviewService;
  resolver: MemoryAgentResolver;
  recallService: MemoryRecallService;
  completeText: ReturnType<typeof vi.fn<(agentId: string, req: CompleteTextReq) => Promise<string>>>;
  envelopes: PlatformEventEnvelope[];
}

/**
 * 编排完整闭环场景：同一个 database 上搭复盘服务 + 整理 Resolver + 回想服务，
 * scripted completeText 用一个共享行队列依次喂三段输出（复盘 JSON → propose_fact → final）。
 * 共享的 memory_recalls 基线行使 EvidenceRefs 的 session:s1 可被 MemoryPolicy 验证。
 */
function buildClosedLoopScene(script: readonly string[]): ClosedLoopScene {
  const { paths, database, agentsDir } = createContext();
  // 会话证据验证基线（MemoryPolicy：session:<id> 证据必须在回忆账本中可验证）
  database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
  `).run(crypto.randomUUID());

  const replayStore = new EventReplayStore();
  const journalStore = new MemoryJournalStore(database);
  const factStore = new MemoryFactStore(database);
  const eventStore = new MemoryEventStore(database);
  const recallStore = new MemoryRecallStore(database);
  const batchStore = new MemoryBatchStore(database);
  const watermarkStore = new MemoryWatermarkStore(database);
  const summaryStore = new SessionSummaryStore(database);
  const proposalStore = new MemoryProposalStore(database);

  const sessionPath = writeSession(paths.home, "s1");
  const view = makeView("s1", sessionPath);

  const remaining = [...script];
  const completeText = vi.fn(async (_agentId: string, _req: CompleteTextReq): Promise<string> => remaining.shift() ?? "{}");

  const reviewService = new BackgroundReviewService({
    replayStore,
    sessionService: { getView: vi.fn(() => view) } as never,
    journalStore,
    pinnedStore: new PinnedMemoryStore(database),
    agentsDir,
    sessionPathResolver: () => sessionPath,
    completeText,
    settingsResolver: () => ({ enabled: true, reviewEnabled: true }),
  });

  const policy = new MemoryPolicy({
    factStore, recallStore, journalStore, batchStore, eventStore,
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  const application = new ProposalApplication({
    database, proposalStore, factStore, eventStore, journalStore, batchStore, watermarkStore, policy,
    audit: new AuditRecorder({
      database,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
    }),
  });
  const activationUpdater = new ActivationUpdater({ database, factStore, recallStore });
  const envelopes: PlatformEventEnvelope[] = [];
  const resolver = new MemoryAgentResolver({
    batchStore, journalStore, factStore, eventStore, recallStore, proposalStore, watermarkStore, summaryStore,
    application,
    settingsResolver: () => ({ ...defaultMemoryAgentSettings(), deepDiveMode: "experimental-agent" }),
    completeText,
    sessionPathResolver: () => sessionPath,
    agentsDir,
    publish: (envelope) => envelopes.push(envelope),
    activationUpdater,
  });
  const recallService = new MemoryRecallService({
    factStore, eventStore, recallStore,
    sessionIndex: new SessionIndex(database),
    publish: () => {},
    agentsDir,
    activationUpdater,
  });
  // 每日整理候选：一个 sealed 批次（记忆 Agent 只读该批次限定的会话）
  batchStore.createBatch({
    id: "b1", agentId: "a1", sessionId: "s1", revision: { branchRevision: "br" },
    sourceStartEntry: "e1", sourceEndEntry: "e2", priority: 0,
  }, "sealed");

  return {
    replayStore, journalStore, factStore, batchStore, recallStore,
    proposalStore, watermarkStore, reviewService, resolver, recallService,
    completeText, envelopes,
  };
}

describe("记忆激活闭环（切片 1.75 T15）", () => {
  it("全链路：turn.completed 复盘产意图 → 每日整理审批应用 → search_memory 带 provenance/confidence 召回", async () => {
    const scene = buildClosedLoopScene([
      JSON.stringify({ intents: [{ fact: BACKGROUND_FACT, tags: ["偏好"], priority: 4 }] }),
      JSON.stringify({ kind: "tool_call", tool: "propose_fact", args: { payload: { fact: BACKGROUND_FACT }, evidenceRefs: ["session:s1", "batch:b1"], reason: "复盘意图：用户偏好项目符号列表", confidence: 0.95 } }),
      JSON.stringify({ kind: "final", report: { summary: "整理完成" } }),
    ]);
    const { replayStore, journalStore, factStore, batchStore, recallStore, proposalStore, watermarkStore, reviewService, resolver, recallService, completeText, envelopes } = scene;

    // ── 阶段 1：复盘产出意图（turn.completed → background_review）──
    replayStore.publish(turnCompleted("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await reviewService.flush();
    expect(completeText).toHaveBeenCalledTimes(1);
    const pending = journalStore.listPending("a1");
    expect(pending).toHaveLength(1);
    const intent = pending[0]!;
    expect(intent.actor).toBe("background_review");
    expect(intent.intentType).toBe("remember");
    expect(intent.payload["fact"]).toBe(BACKGROUND_FACT);
    expect(intent.priority).toBe(4);
    expect(intent.status).toBe("pending");
    // 复盘只写 journal 意图，不直写长期库（架构边界）
    expect(factStore.listByAgent("a1")).toHaveLength(0);
    // 审批前 search_memory 无命中（意图未生效，不可召回）
    const before = await recallService.search({ agentId: "a1", sessionId: "s1", args: { query: "项目符号列表" } });
    expect(before.status).toBe("empty");
    expect(before.hits).toHaveLength(0);
    reviewService.stop();

    // ── 阶段 2：每日整理审批生效（runner 提案 → MemoryPolicy 审批 → ProposalApplication 应用）──
    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.applied).toBe(1);
    expect(outcome.rejected).toBe(0);
    const created = factStore.listByAgent("a1").find((f) => f.fact === BACKGROUND_FACT);
    expect(created).toBeDefined();
    expect(created!.status).toBe("active");
    // 来源标记正确：agent_approved + 证据引用落 sourceRefs
    expect(created!.source).toBe("agent_approved");
    expect(created!.sourceRefs).toEqual(["session:s1", "batch:b1"]);
    expect(created!.confidence).toBe(0.95);
    // 复盘意图在审批时仍是 pending 的 remember 意图 → 确定性初始强度 ≥70（用户意图档）
    expect(created!.retentionStrength).toBeGreaterThanOrEqual(70);
    // 提案经审批并持久化为 applied
    expect(Object.values(proposalStore.listByRun(outcome.runId)).some((p) => p.type === "create_fact" && p.status === "applied")).toBe(true);
    // journal 意图结算为 applied，pending 清空；审批留痕（memory_agent actor）
    expect(journalStore.get(intent.id)?.status).toBe("applied");
    expect(journalStore.listPending("a1")).toHaveLength(0);
    expect(journalStore.listByAgent("a1").some((j) => j.actor === "memory_agent" && j.intentType === "remember" && j.payload["mutationType"] === "create_fact" && j.status === "applied")).toBe(true);
    // 批次结算 + memory.md 投影过期标记（markdown 通道将由注入重建）
    expect(batchStore.get("b1")?.status).toBe("applied");
    expect(watermarkStore.listDirty("a1").some((w) => w.scope === "markdown")).toBe(true);
    // 整理 SSE 事件齐备
    const types = envelopes.map((e) => e.type);
    expect(types).toContain("memory.agent.started");
    expect(types).toContain("memory.agent.completed");

    // ── 阶段 3：search_memory 召回（provenance/confidence 字段在场）──
    const result = await recallService.search({ agentId: "a1", sessionId: "s1", args: { query: "项目符号列表", depth: "quick" } });
    expect(result.status).toBe("completed");
    const hit = result.hits.find((h) => h.targetType === "fact" && h.snippet.includes(BACKGROUND_FACT));
    expect(hit).toBeDefined();
    expect(hit!.provenance.sessionId).toBe("session:s1");
    expect(hit!.confidence).toBe(0.95);
    expect(hit!.sourceType).toBe("memory_recall");
    expect(hit!.strengthTier).toBeDefined();
    // 回忆账本新增命中行 → activation 投影随召回更新（>0）
    expect(recallStore.listByAgent("a1").some((r) => r.targetId === String(created!.id))).toBe(true);
    expect(factStore.getById(created!.id)?.activationStrength ?? 0).toBeGreaterThan(0);
    // 无关 query 不命中（只按需召回，非全量注入）
    const miss = await recallService.search({ agentId: "a1", sessionId: "s1", args: { query: "量子退火算法" } });
    expect(miss.status).toBe("empty");
    expect(miss.hits).toHaveLength(0);
    // scripted LLM 全程只被调用 3 次：复盘 1 + 整理 2（propose_fact → final）
    expect(completeText).toHaveBeenCalledTimes(3);
  });

  it("提案文本与复盘意图不一致 → 事实照常落地但意图保持 pending（不误结 applied）", async () => {
    const scene = buildClosedLoopScene([
      JSON.stringify({ intents: [{ fact: BACKGROUND_FACT, tags: ["偏好"], priority: 4 }] }),
      JSON.stringify({ kind: "tool_call", tool: "propose_fact", args: { payload: { fact: "用户偏好要点式回答" }, evidenceRefs: ["session:s1", "batch:b1"], reason: "整理候选", confidence: 0.8 } }),
      JSON.stringify({ kind: "final", report: { summary: "整理完成" } }),
    ]);
    const { replayStore, journalStore, factStore, batchStore, reviewService, resolver, completeText } = scene;

    replayStore.publish(turnCompleted("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await reviewService.flush();
    const pending = journalStore.listPending("a1");
    expect(pending).toHaveLength(1);
    const intent = pending[0]!;
    expect(intent.actor).toBe("background_review");
    reviewService.stop();

    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");
    expect(outcome.applied).toBe(1);
    // 模型提了另一条事实：照常通过审批落地
    const created = factStore.listByAgent("a1").find((f) => f.fact === "用户偏好要点式回答");
    expect(created).toBeDefined();
    expect(created!.status).toBe("active");
    // 原复盘意图因文本不匹配未被结算——保持 pending，可被后续整理继续处理
    expect(journalStore.get(intent.id)?.status).toBe("pending");
    expect(journalStore.listPending("a1")).toHaveLength(1);
    // 批次照常结算（事实已应用）
    expect(batchStore.get("b1")?.status).toBe("applied");
    expect(completeText).toHaveBeenCalledTimes(3);
  });
});
