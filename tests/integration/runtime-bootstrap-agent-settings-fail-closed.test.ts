import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import type { AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import {
  createRuntimeBootstrap,
  EnsureRuntimeError,
} from "../../src/server/routes/runtime-bootstrap.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复回归：Agent 绑定 Session 的设置读取失败必须 fail-closed。
// 缺陷背景：runtime-bootstrap.ts 原实现 catch 住 agentStore.getSettings
// 的异常并静默继续创建 Runtime——沙箱能力（extraReadPaths/protectedPaths）
// 随 agentSettings 一起丢失，Session 以"无沙箱配置"运行（fail-open）。
// 修复后：读取失败 → EnsureRuntimeError（SESSION_ERROR / 500，中文稳定
// 文案，不回显内部路径与异常细节），不创建任何 Runtime。
// 边界：agentStore/paths 未注入（组合根缺省）不属于"读取失败"，维持原状。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];
const openSessionServices: SessionService[] = [];
const openPromptServices: PromptService[] = [];

const blankBaseColor = {
  persona: "测试人格",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

afterEach(() => {
  for (const promptService of openPromptServices.splice(0)) {
    try { promptService.dispose(); } catch { /* ignore */ }
  }
  for (const sessionService of openSessionServices.splice(0)) {
    try { sessionService.closeAll(); } catch { /* ignore */ }
  }
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

/**
 * 只让 getSettings 抛错的 AgentStore（getBaseColor 等其余读取正常）。
 * 精确模拟"Agent 数据可读但设置读取失败"：若连 identity 都不可读，
 * ensureRuntime 会在人设装配路径先失败（既有的外层 500 兜底），测不到本修复。
 */
class SettingsReadFailureAgentStore extends AgentStore {
  override getSettings(_agentId: string): AgentSettingsV2 {
    throw new Error("注入的设置读取失败（测试内部细节，不得进入错误响应）");
  }
}

interface BootstrapWorld {
  home: string;
  paths: ReturnType<typeof getRuntimePaths>;
  database: import("better-sqlite3").Database;
  audit: AuditRecorder;
  sessionService: SessionService;
  promptService: PromptService;
  replayStore: EventReplayStore;
  agentStore: AgentStore;
  app: ReturnType<typeof createTrustedServerApp>["app"];
  sessionId: string;
  agentId: string;
}

async function waitIdle(promptService: PromptService, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!promptService.isBusy(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`会话 ${sessionId} 未在限时内回到空闲`);
}

/** 创建 Agent + 绑定该 Agent 的 Session（world 阶段全部走真实 AgentStore）。 */
async function createAgentBoundWorld(): Promise<BootstrapWorld> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-bootstrap-fc-"));
  temporaryDirectories.push(home);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: home });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  // Session 创建走 fail-closed 审计（audit 缺失时路由拒绝创建）
  const audit = new AuditRecorder({
    database,
    producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot-fc", appVersion: "test", hostPlatform: process.platform },
  });
  const sessionService = new SessionService(paths, new SessionIndex(database));
  openSessionServices.push(sessionService);
  const promptService = new PromptService();
  openPromptServices.push(promptService);
  const replayStore = new EventReplayStore();
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({
    id: "agent-fc",
    name: "Fail-closed 回归助手",
    baseColor: blankBaseColor,
    sandbox: { protectedPaths: ["secrets/"] },
  });
  const { app } = createTrustedServerApp({
    paths,
    database,
    sessionService,
    promptService,
    replayStore,
    agentStore,
    audit,
  });
  const createRes = await app.request("http://127.0.0.1/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "设置读取失败回归会话", agentId: "agent-fc" }),
  });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };
  return {
    home,
    paths,
    database,
    audit,
    sessionService,
    promptService,
    replayStore,
    agentStore,
    app,
    sessionId: created.id,
    agentId: "agent-fc",
  };
}

describe("Runtime Bootstrap：Agent 设置读取失败 fail-closed（P1 审计修复回归）", () => {
  it("Agent 绑定 Session + getSettings 抛错：ensureRuntime 拒绝且不创建 Runtime", async () => {
    const world = await createAgentBoundWorld();
    const bootstrap = createRuntimeBootstrap({
      promptService: world.promptService,
      sessionService: world.sessionService,
      replayStore: world.replayStore,
      paths: world.paths,
      agentStore: new SettingsReadFailureAgentStore(world.paths.agents),
      database: world.database,
    });

    const failure: unknown = await bootstrap.ensureRuntime(world.sessionId).then(
      () => {
        throw new Error("getSettings 失败时 ensureRuntime 必须拒绝，不得静默创建 Runtime");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EnsureRuntimeError);
    const ensureError = failure as EnsureRuntimeError;
    // 稳定错误：HTTP 档位 + 稳定错误码 + 中文稳定文案（不含内部路径/异常细节）
    expect(ensureError.status).toBe(500);
    expect(ensureError.apiError.code).toBe("SESSION_ERROR");
    expect(ensureError.apiError.message).toBe("Agent 设置读取失败，已拒绝启动运行时");
    // fail-closed 核心：拒绝后没有任何 Runtime 被创建
    expect(world.promptService.hasRuntime(world.sessionId)).toBe(false);
  });

  it("同一失败经 messages 路由映射为 500 稳定错误响应，且重试仍拒绝", async () => {
    const world = await createAgentBoundWorld();
    const failingStore = new SettingsReadFailureAgentStore(world.paths.agents);
    const { app: failingApp } = createTrustedServerApp({
      paths: world.paths,
      database: world.database,
      sessionService: world.sessionService,
      promptService: world.promptService,
      replayStore: world.replayStore,
      agentStore: failingStore,
      audit: world.audit,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await failingApp.request(
        `http://127.0.0.1/api/sessions/${world.sessionId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "应当被拒绝的消息" }),
        },
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("SESSION_ERROR");
      expect(body.message).toBe("Agent 设置读取失败，已拒绝启动运行时");
      // 错误响应不携带内部异常细节
      expect(JSON.stringify(body)).not.toContain("注入的设置读取失败");
    }
    expect(world.promptService.hasRuntime(world.sessionId)).toBe(false);
  });

  it("getSettings 正常：Agent 绑定 Session 行为与修复前一致（Runtime 创建 + turn 完成）", async () => {
    const world = await createAgentBoundWorld();
    const promptRes = await world.app.request(
      `http://127.0.0.1/api/sessions/${world.sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "设置可读时的正常提问" }),
      },
    );
    expect(promptRes.status).toBe(202);
    await waitIdle(world.promptService, world.sessionId);

    expect(world.promptService.hasRuntime(world.sessionId)).toBe(true);
    const turnEvents = world.replayStore
      .listSessionStreams(world.sessionId)
      .flatMap((streamId) => world.replayStore.getSince(streamId, 0).events)
      .filter((event) => event.type === "turn.completed");
    expect(turnEvents.length).toBeGreaterThan(0);
    // world 前置：Agent 设置含沙箱配置且可读（沙箱配置生效路径本身由
    // sandbox-service/sandbox-tools 既有测试覆盖，此处守护 bootstrap 不降级）
    const settings = world.agentStore.getSettings(world.agentId);
    expect(settings.sandbox?.protectedPaths).toContain("secrets/");
  });

  it("无 Agent 绑定的 Session 不受影响：即使 getSettings 会抛错也正常创建 Runtime", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-bootstrap-fc-noagent-"));
    temporaryDirectories.push(home);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: home });
    const database = openMetadataDatabase(paths.database);
    openDatabases.push(database);
    const audit = new AuditRecorder({
      database,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot-fc-noagent", appVersion: "test", hostPlatform: process.platform },
    });
    const sessionService = new SessionService(paths, new SessionIndex(database));
    openSessionServices.push(sessionService);
    const promptService = new PromptService();
    openPromptServices.push(promptService);
    const replayStore = new EventReplayStore();
    // agentStore 存在且 getSettings 坏——只有 Agent 绑定会话才允许触发 fail-closed
    const failingStore = new SettingsReadFailureAgentStore(paths.agents);
    const { app } = createTrustedServerApp({
      paths,
      database,
      sessionService,
      promptService,
      replayStore,
      agentStore: failingStore,
      audit,
    });
    const createRes = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "无绑定会话", cwd: home }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const promptRes = await app.request(
      `http://127.0.0.1/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "无 Agent 绑定的提问" }),
      },
    );
    expect(promptRes.status).toBe(202);
    await waitIdle(promptService, created.id);
    expect(promptService.hasRuntime(created.id)).toBe(true);
  });
});
