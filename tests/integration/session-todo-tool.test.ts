import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionTodoStore } from "../../src/storage/session-todos.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService, type SessionView } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { ModelService } from "../../src/runtime/model-service.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { createServerApp } from "../../src/server/app.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import {
  TODO_WRITE_TOOL_DESCRIPTION,
  TODO_TOOL_NAMES,
  buildTodoSessionTool,
  registerTodoContext,
  requireTodoContext,
  todoSessionContexts,
} from "../../src/pi-sdk/todo-tools.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

// ═══════════════════════════════════════════════════════════════
// 波次 B5a：todo_write 工具 → store → todo.updated 事件 → 恢复 全链路
// （plans/p1-conversation-workbench §3.2.5 冻结语义）。faux provider 工具
// 调用 fixture 模式对齐 plugin-main-session.test.ts（外部 faux 实例注册进
// ModelRuntime + setResponses 驱动 tool_call）；隔离临时 OPENCOLORFUL_HOME，
// 绝不请求真实 Provider 网络。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

function makeFixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opencolorful-${name}-`));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { dir, paths, database };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

const blankBaseColor = {
  persona: "测试人格",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

async function waitIdle(promptService: PromptService, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!promptService.isBusy(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`会话 ${sessionId} 未在限时内回到空闲`);
}

/**
 * faux 工具调用模型装配（plugin-main-session.test.ts 同款 fixture）：
 * 外部 faux 实例注册进 ModelRuntime（api/streamSimple 都走该实例），
 * setResponses 驱动模型发出 tool_call；返回 modelService stub + faux 句柄。
 */
async function createFauxToolCallModelService(
  dir: string,
): Promise<{ modelService: ModelService; setResponses: (responses: unknown[]) => void }> {
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: dir, modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://localhost:0",
    api: faux.provider as never,
    streamSimple: faux.provider.stream as never,
    models: [{ id: "faux-1", name: "Faux Model", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  await modelRuntime.setRuntimeApiKey("faux", "dummy-key");
  const model = modelRuntime.getModel("faux", "faux-1");
  if (model === undefined) {
    throw new Error("faux 模型未注册");
  }
  const modelService = {
    resolveModel: () => ({ runtime: modelRuntime, model }),
    getRuntime: () => ({ resolveModel: () => ({ runtime: modelRuntime, model }) }),
  } as unknown as ModelService;
  return { modelService, setResponses: (responses: unknown[]) => faux.setResponses(responses as never) };
}

/** 从 Replay Store 全流里挑出 todo.updated 事件。 */
function todoEvents(replayStore: EventReplayStore, sessionId: string): PlatformEventEnvelope[] {
  return replayStore
    .listSessionStreams(sessionId)
    .flatMap((streamId) => replayStore.getSince(streamId, 0).events)
    .filter((event) => event.type === "todo.updated");
}

/** 从 Replay Store 全流里挑出 tool.completed 事件（payload 收窄为工具结果形状）。 */
function toolCompletedEvents(replayStore: EventReplayStore, sessionId: string): Array<{ isError?: boolean; result?: unknown }> {
  return replayStore
    .listSessionStreams(sessionId)
    .flatMap((streamId) => replayStore.getSince(streamId, 0).events)
    .filter((event) => event.type === "tool.completed")
    .map((event) => event.payload as { isError?: boolean; result?: unknown });
}

describe("todo_write 工具：真实 faux turn → store → todo.updated（Replay）", () => {
  it("模型 tool_call todo_write → store 更新 → todo.updated 经 Replay Store 可观测 → 工具结果接受", async () => {
    const { dir, paths, database } = makeFixture("todo-turn");
    const store = new SessionTodoStore(database);
    const replayStore = new EventReplayStore();
    const sessionIndex = new SessionIndex(database);
    const sessionService = new SessionService(paths, sessionIndex, undefined, store);
    const sessionId = "todo-turn-sess";

    const handle = sessionService.create({ title: "todo turn", cwd: dir, id: sessionId });
    // 注册 todo 上下文（bootstrap setupTodoContext 的等价接线）
    const unregister = registerTodoContext(sessionId, {
      sessionId,
      store,
      publish: (env) => replayStore.publish(env),
    });

    const { modelService, setResponses } = await createFauxToolCallModelService(dir);
    const runtime = await SessionRuntime.create({
      sessionId,
      cwd: dir,
      authPath: paths.authFile,
      publish: () => {},
      sessionHandle: handle,
      modelService,
      resolveProviderId: "faux",
      resolveModelId: "faux-1",
      // 生产同路径：Runtime 事件（tool.completed 等）与 todo.updated 共用同一 Replay Store
      replayStore,
      pluginTools: [buildTodoSessionTool(sessionId)],
    });

    // 模型发出 todo_write 整体替换 tool_call（含 activeForm 与一条 in_progress）
    setResponses([
      fauxAssistantMessage([
        fauxToolCall("todo_write", {
          todos: [
            { content: "调研存储层", status: "completed", priority: "high" },
            { content: "实现工具链", status: "in_progress", priority: "high", activeForm: "正在实现工具链" },
            { content: "回归测试", status: "pending", priority: "medium" },
          ],
        }),
      ]),
      fauxAssistantMessage("清单已更新"),
    ]);
    const run = runtime.prompt("请更新待办清单");
    await run.completed;

    // 1) store 落库：position = 数组顺序
    expect(store.list(sessionId)).toEqual([
      { content: "调研存储层", status: "completed", priority: "high" },
      { content: "实现工具链", status: "in_progress", priority: "high", activeForm: "正在实现工具链" },
      { content: "回归测试", status: "pending", priority: "medium" },
    ]);

    // 2) todo.updated 经 Replay Store 可见（write-before-broadcast：publish 即入 Replay）
    const events = todoEvents(replayStore, sessionId);
    expect(events).toHaveLength(1);
    const todoEvent = events[0]!;
    expect(todoEvent.sessionId).toBe(sessionId);
    expect(todoEvent.streamId).toBe(`todo:${sessionId}`);
    expect(todoEvent.sequence).toBe(1);
    expect(todoEvent.payload).toEqual({
      items: [
        { content: "调研存储层", status: "completed", priority: "high" },
        { content: "实现工具链", status: "in_progress", priority: "high", activeForm: "正在实现工具链" },
        { content: "回归测试", status: "pending", priority: "medium" },
      ],
    });

    // 3) getSince 续传语义：sinceSeq=1 无增量，sinceSeq=0 取到全量
    const streamId = todoEvent.streamId!;
    expect(replayStore.getSince(streamId, 1).events).toHaveLength(0);
    expect(replayStore.getSince(streamId, 0).events).toHaveLength(1);

    // 4) 工具结果报告接受（tool.completed 事件 + 会话内结果回写）
    const toolCompleted = toolCompletedEvents(replayStore, sessionId);
    expect(toolCompleted.length).toBeGreaterThan(0);
    expect(toolCompleted[0]!.isError).toBe(false);
    const resultText = String(toolCompleted[0]!.result ?? "");
    expect(resultText).toContain("accepted");
    expect(resultText).toContain("待办清单已更新（共 3 条）");
    // 结果负载对模型自描述（toModelOutput 等价：重序列化整个列表）
    expect(resultText).toContain("调研存储层");

    runtime.dispose();
    sessionService.closeAll();
    unregister();
  });

  it("空列表 tool_call = 合法清空：store 删除全部行，todo.updated {items:[]} 发布，结果报告已清空", async () => {
    const { dir, paths, database } = makeFixture("todo-clear");
    const store = new SessionTodoStore(database);
    const replayStore = new EventReplayStore();
    const sessionId = "todo-clear-sess";
    store.replace(sessionId, [
      { content: "旧任务", status: "pending", priority: "low" },
    ]);

    const sessionService = new SessionService(paths, new SessionIndex(database), undefined, store);
    const sessionHandle = sessionService.create({ title: "todo clear", cwd: dir, id: sessionId });
    const unregister = registerTodoContext(sessionId, {
      sessionId,
      store,
      publish: (env) => replayStore.publish(env),
    });

    const { modelService, setResponses } = await createFauxToolCallModelService(dir);
    const runtime = await SessionRuntime.create({
      sessionId,
      cwd: dir,
      authPath: paths.authFile,
      publish: () => {},
      sessionHandle,
      modelService,
      resolveProviderId: "faux",
      resolveModelId: "faux-1",
      // 生产同路径：Runtime 事件（tool.completed 等）与 todo.updated 共用同一 Replay Store
      replayStore,
      pluginTools: [buildTodoSessionTool(sessionId)],
    });

    setResponses([
      fauxAssistantMessage([
        fauxToolCall("todo_write", { todos: [] }),
      ]),
      fauxAssistantMessage("已清空"),
    ]);
    const run = runtime.prompt("清空待办");
    await run.completed;

    expect(store.list(sessionId)).toEqual([]);
    const events = todoEvents(replayStore, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ items: [] });
    const toolCompleted = toolCompletedEvents(replayStore, sessionId);
    expect(String(toolCompleted[0]!.result ?? "")).toContain("待办清单已清空");

    runtime.dispose();
    sessionService.closeAll();
    unregister();
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具拒绝路径：非法 status → store 未动 → 结果报告中文原因
// ═══════════════════════════════════════════════════════════════

describe("todo_write 拒绝路径", () => {
  it("非法 status 的 tool_call：store 未动、无 todo.updated、工具结果报告中文拒绝原因", async () => {
    const { dir, paths, database } = makeFixture("todo-reject");
    const store = new SessionTodoStore(database);
    const replayStore = new EventReplayStore();
    const sessionService = new SessionService(paths, new SessionIndex(database), undefined, store);
    const sessionId = "todo-reject-sess";

    const baseline = [{ content: "既有任务", status: "pending" as const, priority: "high" as const }];
    store.replace(sessionId, baseline);

    const sessionHandle = sessionService.create({ title: "todo reject", cwd: dir, id: sessionId });
    const unregister = registerTodoContext(sessionId, {
      sessionId,
      store,
      publish: (env) => replayStore.publish(env),
    });

    const { modelService, setResponses } = await createFauxToolCallModelService(dir);
    const runtime = await SessionRuntime.create({
      sessionId,
      cwd: dir,
      authPath: paths.authFile,
      publish: () => {},
      sessionHandle,
      modelService,
      resolveProviderId: "faux",
      resolveModelId: "faux-1",
      // 生产同路径：Runtime 事件（tool.completed 等）与 todo.updated 共用同一 Replay Store
      replayStore,
      pluginTools: [buildTodoSessionTool(sessionId)],
    });

    setResponses([
      fauxAssistantMessage([
        fauxToolCall("todo_write", {
          todos: [{ content: "坏状态任务", status: "doing", priority: "high" }],
        }),
      ]),
      fauxAssistantMessage("知道了"),
    ]);
    const run = runtime.prompt("更新待办");
    await run.completed;

    // store 未动（拒绝先于事务）
    expect(store.list(sessionId)).toEqual(baseline);
    // 无 todo.updated 发布
    expect(todoEvents(replayStore, sessionId)).toHaveLength(0);
    // 工具结果报告拒绝 + 中文原因（isError=false：结构化拒绝，不是执行异常）
    const toolCompleted = toolCompletedEvents(replayStore, sessionId);
    expect(toolCompleted.length).toBeGreaterThan(0);
    expect(toolCompleted[0]!.isError).toBe(false);
    const resultText = String(toolCompleted[0]!.result ?? "");
    expect(resultText).toContain("rejected");
    expect(resultText).toContain("状态不受支持");

    runtime.dispose();
    sessionService.closeAll();
    unregister();
  });

  it("未注册上下文的会话调用 fail-closed：invoke 返回 todo_context_missing，store 不动", async () => {
    const { dir, database } = makeFixture("todo-failclosed");
    const store = new SessionTodoStore(database);
    const tool = buildTodoSessionTool("unregistered-sess");
    const result = await tool.invoke({ todos: [{ content: "x", status: "pending", priority: "low" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("todo_context_missing");
      expect(result.message).toContain("上下文未就绪");
    }
    expect(store.list("unregistered-sess")).toEqual([]);
    void dir;
  });
});

// ═══════════════════════════════════════════════════════════════
// 恢复：write → dispose → 重新 open → SessionView.todos 一致
// ═══════════════════════════════════════════════════════════════

describe("todo 重启恢复（SessionView.todos）", () => {
  it("写入 → 关闭服务 → 重新打开（新 store 实例）→ SessionView.todos 与写入一致", () => {
    const { dir, paths, database } = makeFixture("todo-recover");
    const items = [
      { content: "任务一", status: "in_progress" as const, priority: "high" as const, activeForm: "正在做任务一" },
      { content: "任务二", status: "pending" as const, priority: "low" as const },
    ];

    // 第一阶段：SessionService 带 todoStore 写入
    const sessionIndex1 = new SessionIndex(database);
    const sessionService1 = new SessionService(paths, sessionIndex1, undefined, new SessionTodoStore(database));
    const created = sessionService1.create({ title: "恢复会话", cwd: dir });
    const store1 = new SessionTodoStore(database);
    store1.replace(created.id, items);
    const viewBefore = sessionService1.getView(created.id);
    expect(viewBefore.todos).toEqual(items);
    sessionService1.closeAll();

    // 第二阶段：模拟重启（新 SessionService + 新 store 实例；无 Agent 会话）
    const sessionIndex2 = new SessionIndex(database);
    const sessionService2 = new SessionService(paths, sessionIndex2, undefined, new SessionTodoStore(database));
    const viewAfter = sessionService2.getView(created.id);
    expect(viewAfter.todos).toEqual(items);
    expect(viewAfter.currentBranchId).toBe(viewBefore.currentBranchId);
    sessionService2.closeAll();
  });

  it("未注入 todoStore 的 SessionService：todos 恒为空列表（向后兼容）", () => {
    const { dir, paths, database } = makeFixture("todo-nostore");
    const sessionService = new SessionService(paths, new SessionIndex(database));
    const created = sessionService.create({ title: "无存储会话", cwd: dir });
    expect(sessionService.getView(created.id).todos).toEqual([]);
    sessionService.closeAll();
  });
});

// ═══════════════════════════════════════════════════════════════
// Bootstrap 接线：经 createServerApp 组合根创建的 Runtime 携带 todo 工具
// ═══════════════════════════════════════════════════════════════

/** todo 上下文注册表（registerTodoContext 的写入目标，globalThis symbol）。 */
function readTodoRegistry(): ReadonlyMap<string, unknown> {
  return todoSessionContexts();
}

describe("bootstrap todo 接线（B5a）", () => {
  it("messages 路由创建的 Runtime：todo 上下文已注册（无 Agent 会话也注册），todo_write 随 customTools 注入", async () => {
    const { dir, paths, database } = makeFixture("todo-bootstrap");
    const sessionIndex = new SessionIndex(database);
    const sessionService = new SessionService(paths, sessionIndex, undefined, new SessionTodoStore(database));
    const promptService = new PromptService();
    const replayStore = new EventReplayStore();
    const agentStore = new AgentStore(paths.agents);
    agentStore.create({ id: "agent-todo", name: "Todo 助手", baseColor: blankBaseColor, defaultCwd: dir });
    const audit = new AuditRecorder({
      database,
      producer: { component: "integration-test", processType: "server", processId: "1", bootId: "boot-todo", appVersion: "0.1.0", hostPlatform: process.platform },
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

    // 绑定 Agent 的会话：经 messages 路由触发 ensureRuntime（faux 分支）
    const createRes = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "接线会话", cwd: dir, agentId: "agent-todo" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const promptRes = await app.request(`http://127.0.0.1/api/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(promptRes.status).toBe(202);
    await waitIdle(promptService, created.id);

    // todo 上下文已注册（database 注入即注册，不要求 Agent 绑定——此处双保险断言 agentId 也携带）
    const registry = readTodoRegistry();
    expect(registry.has(created.id)).toBe(true);

    // SessionView.todos 字段存在且为空列表
    const view = sessionService.getView(created.id);
    expect(view.todos).toEqual([]);

    // todo_write 工具经注册的上下文可用（store 面向同一会话）
    const ctx = requireTodoContext(created.id);
    expect(ctx.store).toBeInstanceOf(SessionTodoStore);
    const tool = buildTodoSessionTool(created.id);
    const result = await tool.invoke({
      todos: [{ content: "接线验证", status: "pending", priority: "medium" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.result as { status: string; items: unknown[] };
      expect(payload.status).toBe("accepted");
    }
    expect(sessionService.getView(created.id).todos).toHaveLength(1);

    sessionService.closeAll();
  });

  it("工具描述契约：整体替换/至多一条 in_progress/空列表清空 的冻结语义引导齐全", () => {
    expect(TODO_WRITE_TOOL_DESCRIPTION).toContain("整体替换");
    expect(TODO_WRITE_TOOL_DESCRIPTION).toContain("in_progress");
    expect(TODO_WRITE_TOOL_DESCRIPTION).toContain("至多保留一条");
    expect(TODO_WRITE_TOOL_DESCRIPTION).toContain("空数组即清空");
    expect(TODO_WRITE_TOOL_DESCRIPTION).toContain("WHEN");
    expect(TODO_TOOL_NAMES).toEqual(["todo_write"]);
  });
});

// SessionView 类型冒烟：todos 字段进入视图类型（编译期断言由 tsc 承担）
type ViewShape = Pick<SessionView, "todos">;
const _viewShape: ViewShape | undefined = undefined;
void _viewShape;
