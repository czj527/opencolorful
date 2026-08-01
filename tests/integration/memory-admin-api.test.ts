import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryWatermarkStore, SchedulerStateStore } from "../../src/storage/memory/recovery-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { MemoryAgentResolver } from "../../src/runtime/memory/resolver.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { createServerApp } from "../../src/server/app.js";
import { AgentStore } from "../../src/config/agent-store.js";

const temporaryDirectories: string[] = [];
const openDatabases: import("better-sqlite3").Database[] = [];

function createApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-api-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const agentsDir = path.join(dir, "agents");
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({
    id: "a1",
    name: "验收 Agent",
    baseColor: { persona: "验收", personality: [], replyStyle: "简洁", innerSetting: "" },
  });
  fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
  const preferencesStore = new PreferencesStore(paths.preferences);

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
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  const application = new ProposalApplication({
    database, proposalStore, factStore, eventStore, journalStore, batchStore, watermarkStore, policy,
  });
  const resolver = new MemoryAgentResolver({
    batchStore, journalStore, factStore, eventStore, recallStore, proposalStore, watermarkStore, summaryStore,
    application,
    settingsResolver: () => defaultMemoryAgentSettings(),
    completeText: async () => JSON.stringify({ kind: "final", report: { summary: "x" } }),
    sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
    agentsDir,
    publish: () => {},
  });

  const { app } = createServerApp({
    version: "test",
    pid: 1,
    startedAt: Date.now(),
    paths,
    database,
    agentStore,
    preferencesStore,
    memoryAdmin: { resolver, application, preferencesStore, recallStore },
  });
  return { app, dir, paths, database, agentStore, preferencesStore, factStore, recallStore };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("memory admin API", () => {
  it("deep-dive 排队返回 202；rollback 缺少 run 返回 400", async () => {
    const ctx = createApp();
    const base = `http://x/api/agents/a1/memory`;
    const deep = await ctx.app.request(`${base}/deep-dive`, { method: "POST" });
    expect(deep.status).toBe(202);
    const rollback = await ctx.app.request(`${base}/deep-dive/rollback`, { method: "POST" });
    expect(rollback.status).toBe(400);
  });

  it("per-agent 记忆设置：GET 回退全局默认，PUT 覆盖并持久化", async () => {
    const ctx = createApp();
    const base = `http://x/api/agents/a1/memory`;
    const get1 = await ctx.app.request(`${base}/settings`);
    const body1 = await get1.json() as { settings: { dailyRunTime: string } };
    expect(body1.settings.dailyRunTime).toBe("03:00");

    const put = await ctx.app.request(`${base}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...defaultMemoryAgentSettings(), dailyRunTime: "04:30" }),
    });
    expect(put.status).toBe(200);

    const get2 = await ctx.app.request(`${base}/settings`);
    const body2 = await get2.json() as { settings: { dailyRunTime: string } };
    expect(body2.settings.dailyRunTime).toBe("04:30");

    // 非法设置被拒
    const bad = await ctx.app.request(`${base}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(bad.status).toBe(400);
  });

  it("全局记忆默认：GET/PUT /api/preferences/memory", async () => {
    const ctx = createApp();
    const put = await ctx.app.request(`http://x/api/preferences/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...defaultMemoryAgentSettings(), minIdleMinutes: 45 }),
    });
    expect(put.status).toBe(200);
    const get = await ctx.app.request(`http://x/api/preferences/memory`);
    const body = await get.json() as { settings: { minIdleMinutes: number } };
    expect(body.settings.minIdleMinutes).toBe(45);
  });

  it("timeline：事实双强度 + 事件显著度（派生不落库）", async () => {
    const ctx = createApp();
    const fact = ctx.factStore.createFact({
      agentId: "a1", fact: "时间线事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 60, activationStrength: 30,
    });
    // ledger 两日期
    const insert = ctx.database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    insert.run(crypto.randomUUID(), String(fact.id), "2026-07-30T10:00:00.000Z");
    insert.run(crypto.randomUUID(), String(fact.id), "2026-08-01T10:00:00.000Z");

    const res = await ctx.app.request(`http://x/api/agents/a1/memory/timeline`);
    expect(res.status).toBe(200);
    const body = await res.json() as { facts: Array<{ id: number; retentionStrength: number; activationStrength: number; hitDates: number }> };
    const row = body.facts.find((f) => f.id === fact.id);
    expect(row?.retentionStrength).toBe(60);
    expect(row?.activationStrength).toBe(30);
    expect(row?.hitDates).toBe(2);
  });

  it("运行报告：runs 端点按 runId 返回脱敏内容；不存在 404", async () => {
    const ctx = createApp();
    const runsDir = path.join(ctx.paths.agents, "a1", "memory", "runs", "20260801-120000");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, "run.json"), JSON.stringify({ runId: "run-test-1", status: "completed", batchIds: ["b1"] }));
    fs.writeFileSync(path.join(runsDir, "REPORT.md"), "# 整理报告\n- create_fact 已应用\n");

    const ok = await ctx.app.request(`http://x/api/agents/a1/memory/runs/run-test-1`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { run: { status: string }; report: string };
    expect(body.run.status).toBe("completed");
    expect(body.report).toContain("create_fact");

    const missing = await ctx.app.request(`http://x/api/agents/a1/memory/runs/run-nope`);
    expect(missing.status).toBe(404);
  });
});
