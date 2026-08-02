import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { ObservabilityQuery } from "../../src/observability/observability-query.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { instrument } from "../../src/observability/instrument.js";
import { createServerApp } from "../../src/server/app.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-failclosed-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({
    id: "a1",
    name: "审计 Agent",
    baseColor: { persona: "审计", personality: [], replyStyle: "", innerSetting: "" },
  });
  return { dir, paths, database, sessionService, agentStore };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("P0-1 fail-closed 审计接入（复现级测试）", () => {
  it("沙箱策略修改：Audit 不可持久化 → 503 且设置回滚（不再静默成功）", async () => {
    const ctx = createContext();
    // 审计 recorder 挂在已关闭的 DB 上：appendStrict 必然抛错
    const closedDb = openMetadataDatabase(path.join(ctx.dir, "closed.db"));
    closedDb.close();
    const audit = new AuditRecorder({
      database: closedDb,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/agents/a1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: ["C:\\secrets"] }),
    });
    expect(response.status).toBe(503);
    // 设置必须回滚：sandbox 未落盘
    const settings = ctx.agentStore.getSettings("a1");
    expect(settings.sandbox?.protectedPaths ?? []).not.toContain("C:\\secrets");
  });

  it("Session 工作目录修改：Audit 不可持久化 → 503 且 cwd 未变更", async () => {
    const ctx = createContext();
    const closedDb = openMetadataDatabase(path.join(ctx.dir, "closed2.db"));
    closedDb.close();
    const audit = new AuditRecorder({
      database: closedDb,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const session = ctx.sessionService.create({ title: "工作区会话", cwd: process.cwd() });
    const newCwd = path.join(ctx.dir, "workspace-new");
    fs.mkdirSync(newCwd, { recursive: true });
    const response = await app.request(`http://x/api/sessions/${session.id}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceCwd: newCwd, workspaceConfirmed: true }),
    });
    expect(response.status).toBe(503);
    expect(ctx.sessionService.getView(session.id).workspaceCwd ?? null).not.toBe(newCwd);
  });

  it("Provider 凭据变更：Audit 不可持久化 → upsert 抛错且不写入凭据", async () => {
    const ctx = createContext();
    const closedDb = openMetadataDatabase(path.join(ctx.dir, "closed3.db"));
    closedDb.close();
    const audit = new AuditRecorder({
      database: closedDb,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const providerStore = new ProviderStore(ctx.paths.providerSettings);
    const modelService = await ModelService.create(ctx.paths, providerStore, audit);
    await expect(modelService.upsert(
      { providerId: "openai", name: "OpenAI", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1", models: [] },
      "sk-proj-failclosed-123456",
    )).rejects.toThrow();
    // 凭据未写入 auth 文件
    const authRaw = fs.existsSync(ctx.paths.authFile) ? fs.readFileSync(ctx.paths.authFile, "utf8") : "";
    expect(authRaw).not.toContain("sk-proj-failclosed-123456");
    expect(providerStore.list()).toHaveLength(0);
  });

  it("Audit 正常时：沙箱策略修改成功且审计落库（对照）", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/agents/a1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: ["C:\\secrets"] }),
    });
    expect(response.status).toBe(200);
    const settings = ctx.agentStore.getSettings("a1");
    expect(settings.sandbox?.protectedPaths ?? []).toContain("C:\\secrets");
    const auditRow = ctx.database
      .prepare("SELECT action FROM audit_events WHERE action = 'sandbox.policy.changed' ORDER BY id DESC LIMIT 1")
      .get() as { action: string } | undefined;
    expect(auditRow).toBeDefined();
  });
});

describe("Phase 11 第三轮复审（评审 P0 复现级测试）", () => {
  it("P0：appendStrict 返回 rejected（不抛异常）→ 设置仍被拒绝并回滚（原实现忽略返回值）", async () => {
    const ctx = createContext();
    // 审计对象返回 rejected（如事件未注册/目录拒绝），不抛异常
    const rejectingAudit = {
      appendStrict: () => ({ kind: "rejected", eventName: "audit.sandbox.policy_changed", reason: "事件未注册或版本不符" }),
    } as unknown as AuditRecorder;
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit: rejectingAudit,
    });
    const response = await app.request(`http://x/api/agents/a1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: ["C:\secrets"] }),
    });
    expect(response.status).toBe(503);
    const settings = ctx.agentStore.getSettings("a1");
    expect((settings.sandbox?.protectedPaths ?? []) as string[]).not.toContain("C:\secrets");
  });

  it("P0：audit 未配置（undefined）→ 沙箱设置同样被拒绝（不再静默放行）", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ agentStore: ctx.agentStore, sessionService: ctx.sessionService });
    const response = await app.request(`http://x/api/agents/a1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: ["C:\secrets"] }),
    });
    expect(response.status).toBe(503);
    const settings = ctx.agentStore.getSettings("a1");
    expect((settings.sandbox?.protectedPaths ?? []) as string[]).not.toContain("C:\secrets");
  });

  it("P0：Session 工作目录变更在 audit 未配置时同样 503（不再走非审计路径）", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ agentStore: ctx.agentStore, sessionService: ctx.sessionService });
    const session = ctx.sessionService.create({ title: "无审计会话", cwd: process.cwd() });
    const newCwd = path.join(ctx.dir, "workspace-noaudit");
    fs.mkdirSync(newCwd, { recursive: true });
    const response = await app.request(`http://x/api/sessions/${session.id}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceCwd: newCwd, workspaceConfirmed: true }),
    });
    expect(response.status).toBe(503);
    expect(ctx.sessionService.getView(session.id).workspaceCwd ?? null).not.toBe(newCwd);
  });

  it("P0：Provider 凭据在 audit 返回 rejected 时 → upsert 抛错且不写凭据", async () => {
    const ctx = createContext();
    const rejectingAudit = {
      appendStrict: () => ({ kind: "rejected", eventName: "audit.provider.credential_changed", reason: "payload 不符合目录 schema" }),
    } as unknown as AuditRecorder;
    const providerStore = new ProviderStore(ctx.paths.providerSettings);
    const modelService = await ModelService.create(ctx.paths, providerStore, rejectingAudit);
    await expect(modelService.upsert(
      { providerId: "openai", name: "OpenAI", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1", models: [] },
      "sk-proj-rejected-654321",
    )).rejects.toThrow(/审计/);
    const authRaw = fs.existsSync(ctx.paths.authFile) ? fs.readFileSync(ctx.paths.authFile, "utf8") : "";
    expect(authRaw).not.toContain("sk-proj-rejected-654321");
    expect(providerStore.list()).toHaveLength(0);
  });

  it("P0：记忆审批在 audit 未配置时 → applyRun 抛错且事实未修改", () => {
    const ctx = createContext();
    const factStore = new MemoryFactStore(ctx.database);
    // 会话证据基线（policy 校验 session:s1 属于 a1 需要回忆账本条目）
    ctx.database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run("recall-1");
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      eventStore: new MemoryEventStore(ctx.database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const application = new ProposalApplication({
      database: ctx.database,
      proposalStore: new MemoryProposalStore(ctx.database),
      factStore,
      eventStore: new MemoryEventStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      watermarkStore: new MemoryWatermarkStore(ctx.database),
      policy,
      // 不传 audit（fail-closed：未配置即拒绝）
    });
    expect(() => application.applyRun({
      agentId: "a1", runId: "run-noaudit",
      proposals: [{
        id: "p-1", agentId: "a1", runId: "run-noaudit", type: "create_fact",
        targetType: "fact", payload: { fact: "无审计事实" },
        evidenceRefs: ["session:s1"], reason: "测试", confidence: 0.9, status: "pending",
        createdAt: "2026-08-01T00:00:00Z",
      }],
    })).toThrow(/可观测性未初始化/);
    expect(factStore.listByAgent("a1").some((fact) => fact.fact === "无审计事实")).toBe(false);
  });
});
describe("Phase 11 第四轮复审（评审 P0/P1 复现级测试）", () => {
  const rejectingAuditStub = () => ({
    appendStrict: () => ({ kind: "rejected", eventName: "audit.agent.workspace_changed", reason: "ledger 版本不符" }),
    appendStrictMany: () => { throw new Error("审计记录未被接受：ledger 版本不符"); },
  }) as unknown as AuditRecorder;

  it("P0-1a：Agent 创建带 defaultCwd+sandbox，audit 拒绝 → 503 且完全不落盘（原实现 201+落盘+audit 0 条）", async () => {
    const ctx = createContext();
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit: rejectingAuditStub(),
    });
    const response = await app.request(`http://x/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "高风险创建", baseColor: {}, defaultCwd: "C:\\work", sandbox: { protectedPaths: ["secrets/"] } }),
    });
    expect(response.status).toBe(503);
    expect(ctx.agentStore.list()).toHaveLength(1);
    expect(ctx.agentStore.list().some((agent) => agent.identity.name === "高风险创建")).toBe(false);
  });

  it("P0-1a：Agent 创建带 defaultCwd+sandbox，audit 未配置 → 503", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ agentStore: ctx.agentStore, sessionService: ctx.sessionService });
    const response = await app.request(`http://x/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "高风险创建2", baseColor: {}, sandbox: { protectedPaths: ["secrets/"] } }),
    });
    expect(response.status).toBe(503);
    expect(ctx.agentStore.list()).toHaveLength(1);
    expect(ctx.agentStore.list().some((agent) => agent.identity.name === "高风险创建2")).toBe(false);
  });

  it("P0-1a：纯身份创建（无工作区/沙箱字段）不受影响 → 201", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ agentStore: ctx.agentStore, sessionService: ctx.sessionService });
    const response = await app.request(`http://x/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "普通创建", baseColor: {} }),
    });
    expect(response.status).toBe(201);
  });

  it("P0-1b：Session 创建 audit 未配置 → 503 且无会话落盘（原实现 201）", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ agentStore: ctx.agentStore, sessionService: ctx.sessionService });
    const response = await app.request(`http://x/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "无审计会话创建", cwd: process.cwd() }),
    });
    expect(response.status).toBe(503);
    expect(ctx.sessionService.list()).toHaveLength(0);
  });

  it("P0-1b：Session 创建 audit 拒绝 → 503", async () => {
    const ctx = createContext();
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit: {
        appendStrict: () => ({ kind: "rejected", eventName: "audit.session.workspace_bound", reason: "ledger 版本不符" }),
      } as unknown as AuditRecorder,
    });
    const response = await app.request(`http://x/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "拒绝审计会话", cwd: process.cwd() }),
    });
    expect(response.status).toBe(503);
    expect(ctx.sessionService.list()).toHaveLength(0);
  });

  it("P1-3：settings PUT 一次改 defaultCwd+protectedPaths → 200 且两条审计同事务落账", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/agents/a1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultCwd: "C:\\work", protectedPaths: ["secrets/"] }),
    });
    expect(response.status).toBe(200);
    const rows = ctx.database.prepare(
      "SELECT action FROM audit_events ORDER BY id",
    ).all() as Array<{ action: string }>;
    // 三阶段模型（第五轮）：started ×2 → completed ×2（allowed 终态）
    expect(rows.map((row) => row.action)).toEqual([
      "agent.workspace.changed", "sandbox.policy.changed",
      "agent.workspace.changed", "sandbox.policy.changed",
    ]);
    const settings = ctx.agentStore.getSettings("a1");
    expect(settings.defaultCwd).toBe("C:\\work");
    expect(settings.sandbox?.protectedPaths).toContain("secrets/");
  });

  it("P0-2：rollbackRun 在 audit 未配置时抛错且事实/提案状态不变（原实现静默回滚+audit 0 条）", () => {
    const ctx = createContext();
    ctx.database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run("recall-rollback");
    const factStore = new MemoryFactStore(ctx.database);
    const proposalStore = new MemoryProposalStore(ctx.database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      eventStore: new MemoryEventStore(ctx.database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const applierWithAudit = new ProposalApplication({
      database: ctx.database,
      proposalStore,
      factStore,
      eventStore: new MemoryEventStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      watermarkStore: new MemoryWatermarkStore(ctx.database),
      policy,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createdProposal = {
      id: "p-rollback-1", agentId: "a1", runId: "run-rollback", type: "create_fact" as const,
      targetType: "fact" as const, payload: { fact: "待回滚事实" },
      evidenceRefs: ["session:s1"], reason: "测试", confidence: 0.9, status: "pending" as const,
      createdAt: "2026-08-01T00:00:00Z",
    };
    applierWithAudit.applyRun({ agentId: "a1", runId: "run-rollback", proposals: [createdProposal] });
    expect(factStore.listByAgent("a1").some((fact) => fact.status === "active")).toBe(true);
    const auditCountBefore = (ctx.database.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;

    const applierWithoutAudit = new ProposalApplication({
      database: ctx.database,
      proposalStore,
      factStore,
      eventStore: new MemoryEventStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      watermarkStore: new MemoryWatermarkStore(ctx.database),
      policy,
    });
    expect(() => applierWithoutAudit.rollbackRun({ agentId: "a1", runId: "run-rollback" })).toThrow(/可观测性未初始化/);
    expect(factStore.listByAgent("a1").some((fact) => fact.status === "active")).toBe(true);
    expect(proposalStore.getById("p-rollback-1")?.status).toBe("applied");
    const auditCountAfter = (ctx.database.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("P0-2：带 audit 回滚成功 → proposal_reverted + fact_suppressed 审计落账，事实 suppressed", () => {
    const ctx = createContext();
    const observability = new ObservabilityContext({
      database: ctx.database,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      logsRoot: path.join(ctx.dir, "logs"),
      spoolRoot: path.join(ctx.dir, "spool"),
    });
    instrument.init(observability);
    try {
      ctx.database.prepare(`
        INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
        VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
      `).run("recall-rollback2");
      const factStore = new MemoryFactStore(ctx.database);
      const proposalStore = new MemoryProposalStore(ctx.database);
      const policy = new MemoryPolicy({
        factStore,
        recallStore: new MemoryRecallStore(ctx.database),
        journalStore: new MemoryJournalStore(ctx.database),
        batchStore: new MemoryBatchStore(ctx.database),
        eventStore: new MemoryEventStore(ctx.database),
        settingsResolver: () => defaultMemoryAgentSettings(),
      });
      const audit = new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      });
      const applier = new ProposalApplication({
        database: ctx.database,
        proposalStore,
        factStore,
        eventStore: new MemoryEventStore(ctx.database),
        journalStore: new MemoryJournalStore(ctx.database),
        batchStore: new MemoryBatchStore(ctx.database),
        watermarkStore: new MemoryWatermarkStore(ctx.database),
        policy,
        audit,
      });
      const createdProposal = {
        id: "p-rollback-2", agentId: "a1", runId: "run-rollback2", type: "create_fact" as const,
        targetType: "fact" as const, payload: { fact: "待回滚事实2" },
        evidenceRefs: ["session:s1"], reason: "测试", confidence: 0.9, status: "pending" as const,
        createdAt: "2026-08-01T00:00:00Z",
      };
      applier.applyRun({ agentId: "a1", runId: "run-rollback2", proposals: [createdProposal] });
      applier.rollbackRun({ agentId: "a1", runId: "run-rollback2" });
      // 事实被抑制（listByAgent 排除 suppressed，直接查库）
      const statusRow = ctx.database.prepare("SELECT status FROM memory_facts WHERE fact = ?").get("待回滚事实2") as { status: string };
      expect(statusRow.status).toBe("suppressed");
      const actions = (ctx.database.prepare("SELECT action FROM audit_events ORDER BY id").all() as Array<{ action: string }>).map((row) => row.action);
      expect(actions).toContain("memory.proposal.reverted");
      expect(actions).toContain("memory.fact.suppressed");
    } finally {
      instrument.reset();
    }
  });

  it("P1-6：merge 抑制的每个源事实都有 memory.fact.suppressed Activity + 严格 Audit", () => {
    const ctx = createContext();
    const observability = new ObservabilityContext({
      database: ctx.database,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      logsRoot: path.join(ctx.dir, "logs"),
      spoolRoot: path.join(ctx.dir, "spool"),
    });
    instrument.init(observability);
    try {
      ctx.database.prepare(`
        INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
        VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
      `).run("recall-merge");
      const factStore = new MemoryFactStore(ctx.database);
      const f1 = factStore.createFact({ agentId: "a1", fact: "源事实一", tags: [], source: "agent_approved", sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40 });
      const f2 = factStore.createFact({ agentId: "a1", fact: "源事实二", tags: [], source: "agent_approved", sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40 });
      const proposalStore = new MemoryProposalStore(ctx.database);
      const policy = new MemoryPolicy({
        factStore,
        recallStore: new MemoryRecallStore(ctx.database),
        journalStore: new MemoryJournalStore(ctx.database),
        batchStore: new MemoryBatchStore(ctx.database),
        eventStore: new MemoryEventStore(ctx.database),
        settingsResolver: () => defaultMemoryAgentSettings(),
      });
      const audit = new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      });
      const applier = new ProposalApplication({
        database: ctx.database,
        proposalStore,
        factStore,
        eventStore: new MemoryEventStore(ctx.database),
        journalStore: new MemoryJournalStore(ctx.database),
        batchStore: new MemoryBatchStore(ctx.database),
        watermarkStore: new MemoryWatermarkStore(ctx.database),
        policy,
        audit,
      });
      const mergeProposal = {
        id: "p-merge-1", agentId: "a1", runId: "run-merge", type: "merge" as const,
        targetType: "fact" as const, payload: { factIds: [f1.id, f2.id], mergedFact: "合并事实" },
        evidenceRefs: ["session:s1"], reason: "合并测试", confidence: 0.9, status: "pending" as const,
        previousState: { facts: [f1, f2].map((fact) => ({ id: fact.id, fact: fact.fact, status: fact.status, revision: fact.updatedAt })) },
        createdAt: "2026-08-01T00:00:00Z",
      };
      applier.applyRun({ agentId: "a1", runId: "run-merge", proposals: [mergeProposal] });
      // 两个源事实都被取代/抑制（mergeFacts 置 superseded）
      const suppressedCount = (ctx.database.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE status IN ('superseded', 'suppressed')").get() as { n: number }).n;
      expect(suppressedCount).toBe(2);
      const auditActions = (ctx.database.prepare("SELECT action FROM audit_events WHERE action = 'memory.fact.suppressed'").all() as Array<{ action: string }>);
      expect(auditActions).toHaveLength(2);
      const activityRows = ctx.database.prepare("SELECT event_name FROM activity_events WHERE event_name = 'memory.fact.suppressed'").all() as Array<{ event_name: string }>;
      expect(activityRows).toHaveLength(2);
    } finally {
      instrument.reset();
    }
  });
});

describe("Phase 11 第五轮复审（评审 P1 复现级测试）", () => {
  it("P1-1：Agent 创建冲突（409）→ started+failed 终态，绝无 allowed 成功记录（原实现留下两条 allowed）", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "a1", name: "冲突创建", baseColor: {}, defaultCwd: "C:\\work", sandbox: { protectedPaths: ["secrets/"] } }),
    });
    expect(response.status).toBe(409);
    const rows = ctx.database.prepare(
      "SELECT action, decision, reason_code FROM audit_events ORDER BY id",
    ).all() as Array<{ action: string; decision: string; reason_code: string | null }>;
    expect(rows).toEqual([
      { action: "agent.workspace.changed", decision: "allowed", reason_code: null },
      { action: "sandbox.policy.changed", decision: "allowed", reason_code: null },
      { action: "agent.workspace.changed", decision: "denied", reason_code: expect.stringMatching(/已存在|already/i) },
      { action: "sandbox.policy.changed", decision: "denied", reason_code: expect.stringMatching(/已存在|already/i) },
    ]);
  });

  it("P1-1：Session 创建持久化失败（500）→ started+failed 终态，无 allowed 成功记录", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const failingService = ctx.sessionService as unknown as { create: () => never };
    const originalCreate = failingService.create;
    failingService.create = () => { throw new Error("disk full"); };
    try {
      const { app } = createServerApp({
        agentStore: ctx.agentStore,
        sessionService: ctx.sessionService,
        audit,
      });
      const response = await app.request(`http://x/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "失败会话", cwd: process.cwd() }),
      });
      expect(response.status).toBe(500);
      const rows = ctx.database.prepare(
        "SELECT action, decision, reason_code FROM audit_events ORDER BY id",
      ).all() as Array<{ action: string; decision: string; reason_code: string | null }>;
      expect(rows).toEqual([
        { action: "session.workspace.bound", decision: "allowed", reason_code: null },
        { action: "session.workspace.bound", decision: "denied", reason_code: expect.stringContaining("disk full") },
      ]);
      expect(ctx.sessionService.list()).toHaveLength(0);
    } finally {
      failingService.create = originalCreate;
    }
  });

  it("P1-1：偏好写盘失败（400）→ started+failed 终态，无 allowed 成功记录", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);
    const failingStore = preferencesStore as unknown as { update: () => never };
    const originalUpdate = failingStore.update;
    failingStore.update = () => { throw new Error("disk full"); };
    try {
      const { app } = createServerApp({
        agentStore: ctx.agentStore,
        sessionService: ctx.sessionService,
        audit,
        preferencesStore,
        paths: ctx.paths,
        database: ctx.database,
      });
      const response = await app.request(`http://x/api/preferences/observability`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ diagnosticLevel: "warn" }),
      });
      expect(response.status).toBe(400);
      const rows = ctx.database.prepare(
        "SELECT action, decision, reason_code FROM audit_events ORDER BY id",
      ).all() as Array<{ action: string; decision: string; reason_code: string | null }>;
      expect(rows).toEqual([
        { action: "observability.preferences.changed", decision: "allowed", reason_code: null },
        { action: "observability.preferences.changed", decision: "denied", reason_code: expect.stringContaining("disk full") },
      ]);
    } finally {
      failingStore.update = originalUpdate;
    }
  });

  it("P1-2：Agent 审计带 ownerAgentId scope → 按归属查询可命中（原实现 NULL）", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scope 测试", baseColor: {}, sandbox: { protectedPaths: ["secrets/"] } }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { identity: { id: string } };
    const scoped = ctx.database.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE owner_agent_id = ? AND action IN ('agent.workspace.changed', 'sandbox.policy.changed')",
    ).get(created.identity.id) as { n: number };
    expect(scoped.n).toBeGreaterThanOrEqual(1);
    const query = new ObservabilityQuery(ctx.database);
    const page = query.queryAudit({ ownerAgentId: created.identity.id }, null, 50);
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items.every((row) => row.ownerAgentId === created.identity.id)).toBe(true);
  });

  it("P1-2：Session 审计带 sessionId scope → 按会话查询可命中（原实现 NULL）", async () => {
    const ctx = createContext();
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const { app } = createServerApp({
      agentStore: ctx.agentStore,
      sessionService: ctx.sessionService,
      audit,
    });
    const response = await app.request(`http://x/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "scope 会话", cwd: process.cwd() }),
    });
    expect(response.status).toBe(201);
    const session = await response.json() as { id: string };
    const scoped = ctx.database.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE session_id = ? AND action = 'session.workspace.bound'",
    ).get(session.id) as { n: number };
    expect(scoped.n).toBeGreaterThanOrEqual(1);
    const query = new ObservabilityQuery(ctx.database);
    const page = query.queryAudit({ sessionId: session.id }, null, 50);
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items.every((row) => row.sessionId === session.id)).toBe(true);
  });

  it("P1-3：用户触发强度回滚 → actor=user/web、executor=service/agent-server、changedFields 含 retentionStrength", () => {
    const ctx = createContext();
    ctx.database.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
    `).run("recall-r5");
    const factStore = new MemoryFactStore(ctx.database);
    const fact = factStore.createFact({ agentId: "a1", fact: "强度回滚事实", tags: [], source: "agent_approved", sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 40 });
    const proposalStore = new MemoryProposalStore(ctx.database);
    const policy = new MemoryPolicy({
      factStore,
      recallStore: new MemoryRecallStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      eventStore: new MemoryEventStore(ctx.database),
      settingsResolver: () => defaultMemoryAgentSettings(),
    });
    const audit = new AuditRecorder({
      database: ctx.database,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
    });
    const applier = new ProposalApplication({
      database: ctx.database,
      proposalStore,
      factStore,
      eventStore: new MemoryEventStore(ctx.database),
      journalStore: new MemoryJournalStore(ctx.database),
      batchStore: new MemoryBatchStore(ctx.database),
      watermarkStore: new MemoryWatermarkStore(ctx.database),
      policy,
      audit,
    });
    const strengthProposal = {
      id: "p-r5-strength", agentId: "a1", runId: "run-r5", type: "strength_change" as const,
      targetType: "fact" as const, targetId: String(fact.id), payload: { retentionStrength: 50 },
      evidenceRefs: ["session:s1"], reason: "提强", confidence: 0.9, status: "pending" as const,
      previousState: { retention: 40 },
      createdAt: "2026-08-01T00:00:00Z",
    };
    applier.applyRun({ agentId: "a1", runId: "run-r5", proposals: [strengthProposal] });
    expect(factStore.getById(fact.id)?.retentionStrength).toBe(50);
    applier.rollbackRun(
      { agentId: "a1", runId: "run-r5" },
      { actor: { kind: "user", id: "web" }, executor: { kind: "service", id: "agent-server" } },
    );
    expect(factStore.getById(fact.id)?.retentionStrength).toBe(40);
    const row = ctx.database.prepare(
      "SELECT actor_kind, actor_id, executor_kind, executor_id, changed_fields_json FROM audit_events WHERE action = 'memory.proposal.reverted'",
    ).get() as { actor_kind: string; actor_id: string; executor_kind: string; executor_id: string; changed_fields_json: string };
    expect(row.actor_kind).toBe("user");
    expect(row.actor_id).toBe("web");
    expect(row.executor_kind).toBe("service");
    expect(row.executor_id).toBe("agent-server");
    const changedFields = JSON.parse(row.changed_fields_json) as string[];
    expect(changedFields).toContain("retentionStrength");
    expect(changedFields).not.toContain("status");
  });
});
