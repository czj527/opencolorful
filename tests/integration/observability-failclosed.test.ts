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
