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
