import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { PluginFacade } from "../../src/platform/plugin-facade.js";
import { createPiAgentSession, createInMemorySession, type PluginSessionTool } from "../../src/pi-sdk/index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { ModelService } from "../../src/runtime/model-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";
// P1-3：生产接线（messages 路由同款实现，测试直接复用，不再复制逻辑）
import {
  buildPluginSessionTools,
  buildPluginTurnSnapshotFactory,
} from "../../src/server/routes/messages.js";
import { SHOWCASE_SOURCE_DIR } from "./plugin-main-session.fixture.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-main-session-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot", appVersion: "0.1.0", hostPlatform: process.platform },
  });
  return { dir, paths, database, audit };
}

async function installShowcase(facade: PluginFacade): Promise<void> {
  await facade.install(
    { sourceType: "local", ref: SHOWCASE_SOURCE_DIR },
    [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
  );
  await facade.enable("example.sdk-showcase");
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  // node worker 进程句柄可能短暂占用目录（Windows）：清理尽力而为，不掩盖测试结果
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

describe("Phase 12 主会话插件工具（P0-1/P0-2/P1-2 闭环，生产接线）", () => {
  it("绑定过滤：未绑定插件（即使已激活）的工具不注入", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);

    const tools = buildPluginSessionTools(facade, "agent-a", "s1");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.pluginId === "example.sdk-showcase")).toBe(true);
    expect(tools.map((tool) => tool.qualifiedName)).toContain("example.sdk-showcase.echo");
    // 未绑定 Agent 的会话不注入任何工具
    expect(buildPluginSessionTools(facade, "agent-other", "s2")).toHaveLength(0);
  });

  it("P0-1 空列表绑定（允许全部）→ 快照展开当前贡献集，工具真实可调", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    // 空数组 = 允许全部（Web 绑定接口缺省语义）
    facade.bind("agent-a", "example.sdk-showcase", []);
    const tools = buildPluginSessionTools(facade, "agent-a", "s1");
    // 生产注入：允许全部 → echo 与 delete-file 都注入
    expect(tools.map((tool) => tool.qualifiedName).sort()).toEqual([
      "example.sdk-showcase.delete-file",
      "example.sdk-showcase.echo",
    ]);

    // 生产冻结：空列表绑定 → 快照展开为冻结时刻登记的贡献集合（修复前为空数组，includes 校验拒绝一切）
    const snapshotFactory = buildPluginTurnSnapshotFactory(facade);
    const frozen = snapshotFactory("example.sdk-showcase", "agent-a");
    expect(frozen).toBeDefined();
    if (frozen === undefined || !frozen.ok) {
      throw new Error("冻结应成功");
    }
    const snapshot = frozen.snapshot as { contributions: readonly string[] };
    // 快照不可变（deepFreeze）：展开的贡献集 = 该插件全部登记贡献（"允许全部"语义）
    expect(snapshot.contributions).toContain("echo");
    expect(snapshot.contributions).toContain("delete-file");
    expect([...snapshot.contributions].sort()).toEqual(
      facade.hostApi.contributions.list("example.sdk-showcase").map((c) => c.id).sort(),
    );

    // 生产 invoke：带冻结快照的调用真实执行（worker echo）
    const tool = tools.find((t) => t.qualifiedName === "example.sdk-showcase.echo")!;
    tool.turnContext!.current = frozen;
    const result = await tool.invoke({ text: "allow-all-works" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echoed: "allow-all-works" });
    }
  });

  it("P0-2 旧快照调用重启后的新 Runtime → fail-closed 拒绝（不换工具实现）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
    const oldInstanceId = facade.runtimeHost.getInstance("example.sdk-showcase")!.runtimeInstanceId;

    // turn 开始冻结
    const snapshotFactory = buildPluginTurnSnapshotFactory(facade);
    const frozen = snapshotFactory("example.sdk-showcase", "agent-a")!;
    const tools = buildPluginSessionTools(facade, "agent-a", "s1");
    const tool = tools.find((t) => t.qualifiedName === "example.sdk-showcase.echo")!;
    tool.turnContext!.current = frozen;

    // turn 中途插件重启：handoff 停止旧实例 → start 产生新 runtimeInstanceId
    await facade.runtimeHost.handoff("example.sdk-showcase", "plugin_updated");
    await facade.runtimeHost.start("example.sdk-showcase");
    const newInstanceId = facade.runtimeHost.getInstance("example.sdk-showcase")!.runtimeInstanceId;
    expect(newInstanceId).not.toBe(oldInstanceId);

    // 带旧快照调用：RuntimeHost 校验 expectedRuntimeInstanceId 不一致 → fail-closed
    const result = await tool.invoke({ text: "old-turn" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("runtime-mismatch");
      expect(result.message).toContain("运行实例已变更");
    }
  });

  it("P1-2 快照冻结失败 → 工具调用 fail-closed（不静默降级实时权限）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    const tools = buildPluginSessionTools(facade, "agent-a", "s1");
    const tool = tools.find((t) => t.qualifiedName === "example.sdk-showcase.echo")!;

    // 冻结失败（如插件中途卸载导致 create 抛错）：生产 factory 返回 { ok: false }
    // （SessionRuntime.beginTurn 生产路径对抛错/空结果同样包装为失败）
    tool.turnContext!.current = { ok: false, error: "插件未绑定或已禁用，无法创建执行快照" };
    const result = await tool.invoke({ text: "must-not-run" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("snapshot-error");
      expect(result.message).toContain("快照冻结失败");
    }
  });

  it("P0 插件/Runtime 缺失时冻结返回失败（不再 undefined 降级实时权限）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    const tools = buildPluginSessionTools(facade, "agent-a", "s1");
    const tool = tools.find((t) => t.qualifiedName === "example.sdk-showcase.echo")!;

    // 复现第四轮场景：turn 开始时插件已禁用（无运行实例）→ 冻结必须显式失败
    await facade.disable("example.sdk-showcase");
    const snapshotFactory = buildPluginTurnSnapshotFactory(facade);
    const frozen = snapshotFactory("example.sdk-showcase", "agent-a");
    // 修复前：undefined（invoke 侧按实时状态执行 = fail-open）；修复后：显式失败
    expect(frozen).toBeDefined();
    if (frozen === undefined) {
      throw new Error("冻结结果不应为 undefined");
    }
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) {
      expect(frozen.error).toContain("运行实例");
    }

    // 同一 turn（冻结失败结果仍在 turnContext）下调用 → fail-closed，绝不执行
    tool.turnContext!.current = frozen;
    const result = await tool.invoke({ text: "should-have-failed-closed" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("snapshot-error");
      expect(result.message).toContain("已禁用");
    }

    // 即使此后插件重新启用（新 Runtime），本 turn 仍持有失败冻结 → 依旧 fail-closed
    await facade.enable("example.sdk-showcase");
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
    const afterReenable = await tool.invoke({ text: "still-must-not-run" });
    expect(afterReenable.ok).toBe(false);
    if (!afterReenable.ok) {
      expect(afterReenable.code).toBe("snapshot-error");
    }
  });

  it("PI customTools 驱动：模型 tool_call → PluginSessionTool.invoke → ToolService → worker 执行", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);

    const sessionId = "main-session-1";
    const pluginTools = buildPluginSessionTools(facade, "agent-a", sessionId);
    expect(pluginTools).toHaveLength(1);

    // turn 冻结（等价 SessionRuntime.beginTurn）：生产 snapshotFactory 写入 turnContext
    const snapshotFactory = buildPluginTurnSnapshotFactory(facade);
    const frozen = snapshotFactory("example.sdk-showcase", "agent-a");
    expect(frozen).toBeDefined();
    if (frozen === undefined || !frozen.ok) {
      throw new Error("冻结应成功");
    }
    pluginTools[0]!.turnContext!.current = frozen;
    const frozenSnapshot = frozen.snapshot as { pluginId: string; grantRevision: number };

    // faux 模型 + createPiAgentSession + customTools（PI 注册表注入）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-session-faux-"));
    temporaryDirectories.push(dir);
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: dir, modelsPath: null, allowModelNetwork: false });
    // faux 是自定义协议：api 必须传 Provider 实例（字符串协议名走内置协议表，不会消费响应）
    runtime.registerProvider("faux", {
      name: "Faux",
      baseUrl: "http://localhost:0",
      api: faux.provider as never,
      streamSimple: faux.provider.stream as never,
      models: [{ id: "faux-1", name: "Faux Model", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    });
    await runtime.setRuntimeApiKey("faux", "dummy-key");
    const model = runtime.getModel("faux", "faux-1");
    if (model === undefined) {
      throw new Error("faux 模型未注册");
    }
    const modelRuntimeStub = { resolveModel: () => ({ runtime, model }) };
    const agent = await createPiAgentSession({
      sessionId,
      cwd: dir,
      authPath: path.join(dir, "auth.json"),
      modelRuntime: modelRuntimeStub as never,
      providerId: "faux",
      modelId: "faux-1",
      sessionHandle: createInMemorySession(dir),
      systemPrompt: "你是测试助手",
      customTools: pluginTools,
    });

    // invoke spy：记录 PluginSessionTool.invoke 被 PI 工具执行器调用的情况
    const calls: Array<{ params: unknown; frozen: boolean }> = [];
    const tool = pluginTools[0]!;
    const originalInvoke = tool.invoke;
    tool.invoke = async (params: unknown, signal?: AbortSignal) => {
      calls.push({ params, frozen: tool.turnContext?.current !== undefined });
      return originalInvoke(params, signal);
    };

    // 模型发出 tool_call（插件工具名 pluginId.toolId 命名空间）
    faux.setResponses([fauxAssistantMessage([fauxToolCall("example.sdk-showcase.echo", { text: "hello-main-session" })])]);
    await agent.prompt("请调用 echo 工具");

    // PI customTools 执行链：tool_call → execute → PluginSessionTool.invoke → ToolService → worker
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({ text: "hello-main-session" });
    // P0-2：invoke 时 turnContext 已冻结（snapshot/state 传入 ToolService）
    expect(calls[0]!.frozen).toBe(true);
    // turn 快照内容：插件版本 + 授权修订（grantRevision >= 1 表示已授权）
    const snapshot = frozenSnapshot as { pluginId: string; pluginVersion: string; grantRevision: number };
    expect(snapshot.pluginId).toBe("example.sdk-showcase");
    expect(snapshot.grantRevision).toBeGreaterThanOrEqual(1);
    // worker 真实执行结果（无条件断言，不依赖内部 _handle 结构）
    const echoed = calls[0]!.params as { text: string };
    const toolResult = await tool.invoke({ text: echoed.text });
    expect(toolResult.ok).toBe(true);
    if (toolResult.ok) {
      expect(toolResult.result).toEqual({ echoed: "hello-main-session" });
    }
    // 会话内模型可见的工具执行记录存在（工具结果回写会话）
    const handle = (agent as unknown as { _handle: unknown })._handle;
    if (handle !== undefined) {
      const toolCalls = (handle as { messageEntries: Array<{ toolCalls?: Array<{ toolName: string; status: string }> }> }).messageEntries.flatMap((e) => e.toolCalls ?? []);
      const executed = toolCalls.find((t) => t.toolName === "example.sdk-showcase.echo");
      if (executed !== undefined) {
        expect(executed.status).toBe("completed");
      }
    }
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
  });

  it("生产链全闭环：SessionRuntime（生产类）+ beginTurn 冻结 + faux tool_call → worker 执行（无条件事件断言）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);

    const sessionId = "prod-chain-session";
    // 生产接线：buildPluginSessionTools（invoke 闭包 + turnContext 槽）+
    // buildPluginTurnSnapshotFactory（beginTurn 每 turn 调用的工厂）
    const pluginTools = buildPluginSessionTools(facade, "agent-a", sessionId);
    const snapshotFactory = buildPluginTurnSnapshotFactory(facade);
    expect(pluginTools).toHaveLength(1);

    // faux 模型（真实模型分支等价物：ModelService stub 提供 faux provider 实例）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-chain-faux-"));
    temporaryDirectories.push(dir);
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
    const modelServiceStub = {
      resolveModel: () => ({ runtime: modelRuntime, model }),
      getRuntime: () => ({ resolveModel: () => ({ runtime: modelRuntime, model }) }),
    } as unknown as ModelService;

    // SessionRuntime（生产类）：真实模型分支 → createPiAgentSession(customTools) →
    // prompt 时 beginTurn（生产）每 turn 冻结 → PI 工具执行器 → invoke 闭包（生产）
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionHandle = createInMemorySession(dir);
    const runtime = await SessionRuntime.create({
      sessionId,
      cwd: dir,
      authPath: path.join(dir, "auth.json"),
      publish: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      sessionHandle,
      modelService: modelServiceStub,
      resolveProviderId: "faux",
      resolveModelId: "faux-1",
      agentId: "agent-a",
      pluginTools,
      snapshotFactory,
    });

    // faux 模型发出插件 tool_call（qualifiedName 命名空间）
    faux.setResponses([fauxAssistantMessage([fauxToolCall("example.sdk-showcase.echo", { text: "prod-chain" })])]);
    const run = runtime.prompt("请调用 echo 工具");
    await run.completed;

    // 无条件断言（公开事件流，不依赖内部 _handle）：tool.started（含插件工具名）+
    // tool.completed（结果回写会话，isError=false）
    const toolStarted = events.filter((e) => e.type === "tool.started");
    expect(toolStarted.length).toBeGreaterThan(0);
    expect(toolStarted[0]!.payload["toolName"]).toBe("example.sdk-showcase.echo");
    const toolCompleted = events.filter((e) => e.type === "tool.completed" && e.payload["isError"] !== true);
    expect(toolCompleted.length).toBeGreaterThan(0);
    // PI 工具结果以双层 JSON 回写：content[0].text = JSON.stringify(worker 返回值)
    const resultText = String(toolCompleted[0]!.payload["result"] ?? "");
    expect(resultText).toContain("echoed");
    expect(resultText).toContain("prod-chain");
    const parsed = JSON.parse(resultText) as { content?: Array<{ text?: string }> };
    const echoed = JSON.parse(parsed.content?.[0]?.text ?? "{}") as { echoed?: string };
    expect(echoed.echoed).toBe("prod-chain");

    // turn 完成事件存在；插件 worker 健康（工具经 RuntimeHost → node worker 真实执行）
    expect(events.some((e) => e.type === "turn.completed" || e.type === "agent.completed")).toBe(true);
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
  });

  it("P1-2 快照按 pluginId 复用：同一插件多工具一次 turn 只冻结一次（同一 snapshotId）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    // 空列表绑定 → echo 与 delete-file 都注入（同插件两个工具）
    facade.bind("agent-a", "example.sdk-showcase", []);
    const pluginTools = buildPluginSessionTools(facade, "agent-a", "memoize-session");
    expect(pluginTools.map((t) => t.qualifiedName).sort()).toEqual([
      "example.sdk-showcase.delete-file",
      "example.sdk-showcase.echo",
    ]);

    // spy factory：记录调用次数与产生的 snapshotId（beginTurn 每 turn 调用）
    const baseFactory = buildPluginTurnSnapshotFactory(facade);
    const calls: Array<{ pluginId: string; snapshotId: string | null }> = [];
    const spyFactory = (pluginId: string, agentId: string) => {
      const result = baseFactory(pluginId, agentId);
      calls.push({
        pluginId,
        snapshotId: result !== undefined && result.ok
          ? (result.snapshot as { snapshotId: string }).snapshotId
          : null,
      });
      return result;
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoize-faux-"));
    temporaryDirectories.push(dir);
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
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const modelServiceStub = {
      resolveModel: () => ({ runtime: modelRuntime, model }),
      getRuntime: () => ({ resolveModel: () => ({ runtime: modelRuntime, model }) }),
    } as unknown as ModelService;

    const runtime = await SessionRuntime.create({
      sessionId: "memoize-session",
      cwd: dir,
      authPath: path.join(dir, "auth.json"),
      publish: () => {},
      sessionHandle: createInMemorySession(dir),
      modelService: modelServiceStub,
      resolveProviderId: "faux",
      resolveModelId: "faux-1",
      agentId: "agent-a",
      pluginTools,
      snapshotFactory: spyFactory,
    });

    // 一次 turn（无 tool_call）：beginTurn 遍历两个工具——memoize 后同插件只冻结一次
    faux.setResponses([fauxAssistantMessage("你好")]);
    const run = runtime.prompt("你好");
    await run.completed;

    const showcaseCalls = calls.filter((c) => c.pluginId === "example.sdk-showcase");
    // 修复前：每工具各调一次（2 个 snapshotId）；修复后：同插件共享一次冻结
    expect(showcaseCalls).toHaveLength(1);
    expect(showcaseCalls[0]!.snapshotId).not.toBeNull();
  });

  it("HTTP 生产链冒烟：messages 路由 → ensureRuntime → 绑定插件会话正常 turn", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await installShowcase(facade);
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);

    const index = new SessionIndex(fixture.database);
    const sessionService = new SessionService(fixture.paths, index);
    const promptService = new PromptService();
    const session = sessionService.create({ title: "插件绑定会话", cwd: process.cwd(), agentId: "agent-a" });
    session.selectModel("faux", "faux-1");

    const { app } = createTrustedServerApp({
      paths: fixture.paths,
      sessionService,
      promptService,
      database: fixture.database,
      audit: fixture.audit,
      pluginFacade: facade,
    });

    // faux 分支的 SessionRuntime 生产路径：resolvePluginTools（生产接线）→
    // SessionRuntime.create（pluginTools/snapshotFactory 注入）→ prompt → beginTurn（每 turn 冻结）
    const response = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(response.status).toBe(202);
    const payload = (await response.json()) as { status?: string; sessionId?: string; streamId?: string };
    expect(payload.status).toBe("accepted");
    expect(payload.sessionId).toBe(session.id);
    expect(payload.streamId).toBeDefined();
    // 会话仍健康：插件工具注入与 turn 冻结未破坏 faux 会话
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
  });
});
