import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";

import { type SubagentRunId, type SubagentThreadId } from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ThreadStore, type SubagentOwnership } from "../../src/runtime/subagents/stores/index.js";
import { createPiSubagentSessionFactory } from "../../src/runtime/subagents/runtime/pi-session-adapter.js";
import { REPORT_SUBAGENT_RESULT_TOOL, subagentInternalToolDefs } from "../../src/runtime/subagents/runtime/internal-tools.js";
import { registerSubagentAbilityExecutor } from "../../src/pi-sdk/subagent-tools-context.js";
import type { SubagentSessionEvent } from "../../src/runtime/subagents/runtime/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T6：PI AgentSession 宿主适配器测试（plans/phase-14.md §13.2）
//
// 真实 ModelRuntime + Faux provider（plugin-main-session 同一模式）：
// - 懒创建：start 时才 createPiAgentSession（customTools 含内部三工具）；
// - 事件映射：first-event / tool-call / model-iteration / token-usage /
//   terminal（prompt resolve）；
// - 内部控制工具 invoke → tool-invoke 事件（resolve 桥接）；能力工具 →
//   abilityExecutor；
// - followUp/steer 追加 prompt → 再次 terminal；start promise 在
//   dispose/abort 时 resolve（T4 契约）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-adapter-"));
  temporaryDirectories.push(dir);
  const database = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(database);
  return { dir, database };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;
const OWNERSHIP: SubagentOwnership = { ownerAgentId: "agent-a", parentSessionId: "sess-main" };

function createThread(db: Database.Database): void {
  const threads = new ThreadStore(db);
  threads.create({
    threadId: THREAD_ID,
    ownerAgentId: OWNERSHIP.ownerAgentId,
    parentSessionId: OWNERSHIP.parentSessionId,
    createdFromTurnId: "turn-1",
    title: "adapter test",
    modelProviderId: "faux",
    modelId: "faux-1",
    modelSource: "user_default",
    thinkingLevel: "normal",
    workspaceCwd: "/tmp",
    capabilityCeiling: {
      ceilingHash: "hash12345678",
      workspaceAccess: "read",
      toolIds: [],
      pluginContributionIds: [],
      skillRefs: [],
      network: "inherit",
      fixedDenials: [],
    },
    contextPacketHash: "hash12345678",
    createdAt: "2026-08-07T10:00:00.000Z",
  });
}

async function createModelRuntime(dir: string) {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({ authPath: dir, modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://localhost:0",
    api: faux.provider as never,
    streamSimple: faux.provider.stream as never,
    models: [{ id: "faux-1", name: "Faux Model", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  await runtime.setRuntimeApiKey("faux", "dummy-key");
  return { faux, runtime };
}

describe("pi-session-adapter", () => {
  it("懒创建 + 事件映射 + 内部工具桥接 + terminal（Faux provider 全链）", async () => {
    const { dir, database } = createContext();
    createThread(database);
    const { faux, runtime } = await createModelRuntime(dir);

    const events: SubagentSessionEvent[] = [];
    const abilityCalls: Array<{ name: string }> = [];
    const factory = createPiSubagentSessionFactory({
      threadStore: new ThreadStore(database),
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
      abilityExecutor: async (input) => {
        abilityCalls.push({ name: input.name });
        return { ok: true, text: `执行了 ${input.name}` };
      },
    });
    const session = await factory.create({
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      runId: RUN_ID,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: "/tmp",
    });
    const unsubscribe = session.onEvent((event) => events.push(event));

    // 模型先调用内部工具 report_subagent_result，再结束
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(REPORT_SUBAGENT_RESULT_TOOL, { disposition: "satisfied", summary: "完成", criteria: [], artifacts: [], unresolvedIssues: [], recommendedNextAction: "accept" })]),
      fauxAssistantMessage("任务完成"),
    ]);

    const startPromise = session.start({
      prompt: "[任务目标] 测试\n",
      tools: [...subagentInternalToolDefs(), { name: "read", description: "read", parameters: { type: "object" } }],
      thinkingLevel: "normal",
    });

    // 等待 tool-invoke 事件（内部工具桥接）
    const deadline = Date.now() + 10000;
    while (!events.some((event) => event.type === "tool-invoke") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const invoke = events.find((event): event is Extract<SubagentSessionEvent, { type: "tool-invoke" }> => event.type === "tool-invoke");
    expect(invoke).toBeDefined();
    expect(invoke?.name).toBe(REPORT_SUBAGENT_RESULT_TOOL);
    // 事件映射检查
    expect(events.some((event) => event.type === "first-event")).toBe(true);
    expect(events.some((event) => event.type === "tool-call")).toBe(true);
    // resolve 桥接：工具结果返回模型
    invoke?.resolve({ ok: true, text: "结果已提交" });

    // 模型结束 → terminal
    const terminalDeadline = Date.now() + 10000;
    while (!events.some((event) => event.type === "terminal") && Date.now() < terminalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminal = events.find((event): event is Extract<SubagentSessionEvent, { type: "terminal" }> => event.type === "terminal");
    expect(terminal?.reason).toBe("completed");
    // start promise 尚未 resolve（会话未终结）
    let started = false;
    void startPromise.then(() => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(false);

    // followUp → 新一轮 prompt → 再次 terminal（P0-1：真实投递——idle 会话
    // 经 prompt+streamingBehavior 触发新轮；补一条响应模拟 provider 继续应答）
    faux.appendResponses([fauxAssistantMessage("第二轮完成")]);
    await expect(session.followUp("补充：需要写测试")).resolves.toBe("applied");
    const secondTerminalDeadline = Date.now() + 10000;
    while (events.filter((event) => event.type === "terminal").length < 2 && Date.now() < secondTerminalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(2);

    // dispose → start promise resolve
    session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);
    unsubscribe();
  });

  it("能力工具经 abilityExecutor 执行（缺省 unavailable fail-closed）", async () => {
    const { dir, database } = createContext();
    createThread(database);
    const { faux, runtime } = await createModelRuntime(dir);

    const events: SubagentSessionEvent[] = [];
    const abilityCalls: Array<{ name: string }> = [];
    const factory = createPiSubagentSessionFactory({
      threadStore: new ThreadStore(database),
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
      abilityExecutor: async (input) => {
        abilityCalls.push({ name: input.name });
        return { ok: true, text: `执行了 ${input.name}` };
      },
    });
    const session = await factory.create({
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      runId: RUN_ID,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: "/tmp",
    });
    session.onEvent((event) => events.push(event));

    // 模型调用能力工具 read
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/tmp/a.txt" })]),
      fauxAssistantMessage("读完了"),
    ]);
    void session.start({
      prompt: "读取文件\n",
      tools: [...subagentInternalToolDefs(), { name: "read", description: "read", parameters: { type: "object" } }],
    });
    const deadline = Date.now() + 10000;
    while (abilityCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(abilityCalls).toContainEqual({ name: "read" });
    session.dispose();
  });

  it("能力工具缺省执行器按 runId 查注册表（spawn 注册路由）", async () => {
    const { dir, database } = createContext();
    createThread(database);
    const { faux, runtime } = await createModelRuntime(dir);

    const events: SubagentSessionEvent[] = [];
    const executed: string[] = [];
    // 模拟 spawn 提交 Run 时注册本 Session 的执行器（T9a §25.4）
    registerSubagentAbilityExecutor(RUN_ID, async (input) => {
      executed.push(input.name);
      return { ok: true, text: `executed: ${input.name}` };
    });
    const factory = createPiSubagentSessionFactory({
      threadStore: new ThreadStore(database),
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
      // 不传 abilityExecutor：缺省查 runId 注册表
    });
    const session = await factory.create({
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      runId: RUN_ID,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: "/tmp",
    });
    session.onEvent((event) => events.push(event));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/tmp/a.txt" })]),
      fauxAssistantMessage("读完了"),
    ]);
    void session.start({
      prompt: "读取文件",
      tools: [...subagentInternalToolDefs(), { name: "read", description: "read", parameters: { type: "object" } }],
    });
    const deadline = Date.now() + 10000;
    while (executed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toContain("read");
    session.dispose();
  });

  it("abort → terminal(interrupted) + start promise resolve", async () => {
    const { dir, database } = createContext();
    createThread(database);
    const { faux, runtime } = await createModelRuntime(dir);

    const events: SubagentSessionEvent[] = [];
    const factory = createPiSubagentSessionFactory({
      threadStore: new ThreadStore(database),
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
    });
    const session = await factory.create({
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      runId: RUN_ID,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: "/tmp",
    });
    session.onEvent((event) => events.push(event));
    faux.setResponses([fauxAssistantMessage("慢慢来")]);

    let started = false;
    const startPromise = session.start({ prompt: "开始\n", tools: subagentInternalToolDefs() });
    void startPromise.then(() => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    session.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.some((event) => event.type === "terminal" && event.reason === "interrupted")).toBe(true);
    expect(started).toBe(true); // abort = 会话终结
    session.dispose();
  });

  it("复审 P0-1：未就绪 → deferred、已终结 → failed（投递结果三态，不静默丢消息）", async () => {
    const { dir, database } = createContext();
    createThread(database);
    const { faux, runtime } = await createModelRuntime(dir);
    const factory = createPiSubagentSessionFactory({
      threadStore: new ThreadStore(database),
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
    });
    const session = await factory.create({
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      runId: RUN_ID,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: "/tmp",
    });
    // 未 start（handle 未创建）：deferred——调用方（Dispatcher）延迟重试，不丢
    await expect(session.steer("早到的纠偏")).resolves.toBe("deferred");
    await expect(session.followUp("早到的 queue")).resolves.toBe("deferred");
    // 已终结：failed——调用方按终态迟到结算
    session.dispose();
    await expect(session.steer("迟到的纠偏")).resolves.toBe("failed");
    await expect(session.followUp("迟到的 queue")).resolves.toBe("failed");
  });
});
