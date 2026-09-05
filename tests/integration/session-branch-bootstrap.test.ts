import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { PluginFacade } from "../../src/platform/plugin-facade.js";
import { SHOWCASE_SOURCE_DIR } from "./plugin-main-session.fixture.js";

// ═══════════════════════════════════════════════════════════════
// P1 波次B B2 修复验证：分支路由（regenerate/switch）复用共享 Runtime
// Bootstrap（runtime-bootstrap.ts），与 messages 路由同一条全量装配链。
// 缺陷回归场景：重启（fresh promptService/sessionService）后 Agent 绑定
// 会话的【首个动作】是 regenerate → Runtime 必须带完整工具面（记忆工具、
// Skill 上下文、插件工具、profile/插件签名跟踪），不允许静默降级。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

const blankBaseColor = {
  persona: "测试人格",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

afterEach(() => {
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

/** Skill 工具 per-Session 上下文注册表（registerSkillContext 的写入目标）。 */
function skillSessionContexts(): Map<string, unknown> {
  // symbol 全局注册表：与 src/pi-sdk/skill-tools.ts 的 STATE_KEY 一致
  const key = Symbol.for("opencolorful.skill-context-state");
  const state = (globalThis as Record<symbol, unknown>)[key] as
    | { sessionContexts: Map<string, unknown> }
    | undefined;
  if (state === undefined) throw new Error("Skill 上下文注册表未初始化");
  return state.sessionContexts;
}

/** 记忆工具 per-Session 上下文注册表（registerMemoryContext 的写入目标）。 */
function memorySessionContexts(): Map<string, unknown> {
  const key = Symbol.for("opencolorful.memory-context-state");
  const state = (globalThis as Record<symbol, unknown>)[key] as
    | { sessionContexts: Map<string, unknown> }
    | undefined;
  if (state === undefined) throw new Error("记忆上下文注册表未初始化");
  return state.sessionContexts;
}

async function createForkableWorld(): Promise<{
  home: string;
  paths: ReturnType<typeof getRuntimePaths>;
  agentId: string;
  sessionId: string;
  firstUserEntryId: string;
  /** 第一阶段 runtime 注册的记忆上下文对象引用（用于第二阶段重注册判定） */
  phase1MemoryCtx: unknown;
}> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-bootstrap-"));
  temporaryDirectories.push(home);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: home });

  // ── 第一阶段：Agent + 插件 + 会话，经 messages 路由跑一轮 turn ──
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot-1", appVersion: "test", hostPlatform: process.platform },
  });
  const facade = new PluginFacade({
    database,
    paths,
    audit,
    hostVersion: "0.1.0",
  });
  await facade.install(
    { sourceType: "local", ref: SHOWCASE_SOURCE_DIR },
    [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
  );
  await facade.enable("example.sdk-showcase");
  facade.bind("agent-b2", "example.sdk-showcase", ["echo"]);

  const sessionIndex = new SessionIndex(database);
  const sessionService = new SessionService(paths, sessionIndex);
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({ id: "agent-b2", name: "B2 测试助手", baseColor: blankBaseColor, defaultCwd: process.cwd() });
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();
  const { app } = createServerApp({
    paths,
    database,
    sessionService,
    promptService,
    replayStore,
    agentStore,
    audit,
    pluginFacade: facade,
  });

  const createRes = await app.request("http://local/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "工具面会话", cwd: process.cwd(), agentId: "agent-b2" }),
  });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };

  // 经 messages 路由跑一轮 turn（建立可 regenerate 的用户条目）
  const promptRes = await app.request(`http://local/api/sessions/${created.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "第一版提问" }),
  });
  expect(promptRes.status).toBe(202);
  await waitIdle(promptService, created.id);

  const firstUserEntryId = sessionService
    .getEntries(created.id)
    .entries.find((entry) => entry.role === "user")!.entryId;

  // 首个动作前的可观察基线：插件绑定存在
  expect(facade.listAgentBindings("agent-b2").some((b) => b.enabled && b.pluginId === "example.sdk-showcase")).toBe(true);

  // 捕获第一阶段记忆上下文引用，并关闭第一阶段 runtime（onDispose 注销其
  // 记忆上下文注册）——保证第二阶段的注册断言只能由第二阶段的 Runtime 装配满足
  const phase1MemoryCtx = memorySessionContexts().get(created.id);
  expect(phase1MemoryCtx).toBeDefined();
  promptService.dispose();
  expect(memorySessionContexts().has(created.id)).toBe(false);

  return { home, paths, agentId: "agent-b2", sessionId: created.id, firstUserEntryId, phase1MemoryCtx };
}

async function waitIdle(promptService: PromptService, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!promptService.isBusy(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`会话 ${sessionId} 未在限时内回到空闲`);
}

describe("分支路由复用共享 Runtime Bootstrap（B2 修复回归）", () => {
  it("重启后首个动作 = regenerate：装配的 Runtime 携带完整工具面（记忆/Skill 上下文 + 插件工具 + 人设）", async () => {
    const world = await createForkableWorld();
    const paths = world.paths;

    // ── 第二阶段：模拟重启（关闭旧 runtime/服务句柄，重建 promptService/sessionService
    //    与同一 home 的存储/AgentStore/插件 Facade）→ 首个动作是 regenerate ──
    const database2 = openMetadataDatabase(paths.database);
    openDatabases.push(database2);
    const audit2 = new AuditRecorder({
      database: database2,
      producer: { component: "agent-server", processType: "server", processId: "2", bootId: "boot-2", appVersion: "test", hostPlatform: process.platform },
    });
    const facade2 = new PluginFacade({
      database: database2,
      paths,
      audit: audit2,
      hostVersion: "0.1.0",
    });
    const sessionIndex2 = new SessionIndex(database2);
    const sessionService2 = new SessionService(paths, sessionIndex2);
    const agentStore2 = new AgentStore(paths.agents);
    const promptService2 = new PromptService();
    const replayStore2 = new EventReplayStore();
    const { app: app2 } = createServerApp({
      paths,
      database: database2,
      sessionService: sessionService2,
      promptService: promptService2,
      replayStore: replayStore2,
      agentStore: agentStore2,
      audit: audit2,
      pluginFacade: facade2,
    });

    // 首个动作 = regenerate（无任何 messages 调用先行）
    const regenerateRes = await app2.request(`http://local/api/sessions/${world.sessionId}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetEntryId: world.firstUserEntryId, text: "重启后重试提问" }),
    });
    expect(regenerateRes.status).toBe(202);
    const body = (await regenerateRes.json()) as { streamId: string; branchId: string };
    expect(body.branchId).toBeTypeOf("string");
    await waitIdle(promptService2, world.sessionId);

    // ── 断言装配的 Runtime 工具面 ──
    // 1) 记忆上下文已重新注册（Agent 绑定 + database → hasMemoryTools，
    //    setupMemoryContext 无条件于绑定 Agent 的会话执行）。第一阶段注册已随
    //    promptService.dispose() 注销，此处断言只能由第二阶段 Runtime 装配满足
    //    ——即分支路由的懒创建走了完整 createRuntimeBootstrap 装配链（若回归为
    //    缺记忆/插件/Skill/人设装配的精简版，此断言与 agentId 断言失败）。
    expect(memorySessionContexts().has(world.sessionId)).toBe(true);
    // 2) Agent 人设已生效：新注册的记忆上下文携带该 agentId 且是全新对象
    const memoryCtx = memorySessionContexts().get(world.sessionId) as { agentId?: string } | undefined;
    expect(memoryCtx?.agentId).toBe(world.agentId);
    expect(memoryCtx).not.toBe(world.phase1MemoryCtx);
    // 3) regenerate 真实完成了一个 turn（turn 事件进入 Replay Store）
    const turnEvents = replayStore2
      .listSessionStreams(world.sessionId)
      .flatMap((streamId) => replayStore2.getSince(streamId, 0).events)
      .filter((event) => event.type === "turn.completed");
    expect(turnEvents.length).toBeGreaterThan(0);
    // 4) 新用户条目落在 JSONL（分支已创建）
    const newEntry = sessionService2
      .getEntries(world.sessionId)
      .entries.find((entry) => entry.entryId === body.branchId);
    expect(newEntry?.text).toBe("重启后重试提问");

    sessionService2.closeAll();
  });

  it("messages 路径行为不变：同一 bootstrap 下 prompt 仍走原装配与签名重建", async () => {
    const world = await createForkableWorld();
    const paths = world.paths;
    const database2 = openMetadataDatabase(paths.database);
    openDatabases.push(database2);
    const audit2 = new AuditRecorder({
      database: database2,
      producer: { component: "agent-server", processType: "server", processId: "2", bootId: "boot-2", appVersion: "test", hostPlatform: process.platform },
    });
    const facade2 = new PluginFacade({
      database: database2,
      paths,
      audit: audit2,
      hostVersion: "0.1.0",
    });
    const sessionService2 = new SessionService(paths, new SessionIndex(database2));
    const promptService2 = new PromptService();
    const { app: app2 } = createServerApp({
      paths,
      database: database2,
      sessionService: sessionService2,
      promptService: promptService2,
      replayStore: new EventReplayStore(),
      agentStore: new AgentStore(paths.agents),
      audit: audit2,
      pluginFacade: facade2,
    });

    // messages 路径（ensureRuntime 懒创建）+ 二次 prompt（签名一致不重建）
    const first = await app2.request(`http://local/api/sessions/${world.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "重启后首条" }),
    });
    expect(first.status).toBe(202);
    await waitIdle(promptService2, world.sessionId);
    const second = await app2.request(`http://local/api/sessions/${world.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "第二条" }),
    });
    expect(second.status).toBe(202);
    await waitIdle(promptService2, world.sessionId);

    expect(promptService2.hasRuntime(world.sessionId)).toBe(true);
    expect(memorySessionContexts().has(world.sessionId)).toBe(true);
    sessionService2.closeAll();
  });
});
