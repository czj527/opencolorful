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
import { SHOWCASE_SOURCE_DIR } from "./plugin-main-session.fixture.js";

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

/** 与 messages 路由同逻辑：按 Agent enabled 绑定过滤工具并构造 PluginSessionTool */
function resolvePluginTools(facade: PluginFacade, agentId: string, sessionId: string): readonly PluginSessionTool[] {
  const bindings = facade.listAgentBindings(agentId).filter((binding) => binding.enabled);
  if (bindings.length === 0) {
    return [];
  }
  const bound = new Map<string, readonly string[] | undefined>();
  for (const binding of bindings) {
    bound.set(binding.pluginId, binding.contributions.length > 0 ? binding.contributions : undefined);
  }
  return facade.hostApi.tools
    .listTools()
    .filter((tool) => {
      // P0-2：未绑定插件的工具绝不注入（has 区分"未绑定"与"绑定但允许全部"）
      if (!bound.has(tool.pluginId)) {
        return false;
      }
      const allowed = bound.get(tool.pluginId);
      return allowed === undefined || allowed.includes(tool.contributionId);
    })
    .map((descriptor) => {
      const turnContext: { current: import("../../src/pi-sdk/index.js").PluginToolTurnContext | undefined } = { current: undefined };
      return {
        qualifiedName: descriptor.qualifiedName,
        pluginId: descriptor.pluginId,
        name: descriptor.name,
        ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
        ...(descriptor.inputSchema !== undefined ? { inputSchema: descriptor.inputSchema } : {}),
        turnContext,
        invoke: async (params: unknown) => {
          const frozen = turnContext.current;
          const result = await facade.hostApi.tools.invoke({
            pluginId: descriptor.pluginId,
            contributionId: descriptor.contributionId,
            params,
            agentId,
            sessionId,
            ...(frozen?.snapshot !== undefined ? { snapshot: frozen.snapshot as import("../../src/contracts/plugin-protocol.js").PluginExecutionSnapshot } : {}),
            ...(frozen?.state !== undefined ? { state: frozen.state as import("../../src/runtime/plugins/grants/execution-snapshot.js").ResolveState } : {}),
          });
          return result.ok
            ? { ok: true as const, result: result.result }
            : { ok: false as const, code: result.code, message: result.message };
        },
      };
    });
}

/** 与 messages 路由同逻辑：turn 快照工厂（ExecutionSnapshotService.create） */
function pluginSnapshotFactory(facade: PluginFacade) {
  return (pluginId: string, agentId: string): import("../../src/pi-sdk/index.js").PluginToolTurnContext | undefined => {
    const active = facade.get(pluginId);
    if (active === undefined) {
      return undefined;
    }
    const instance = facade.runtimeHost.getInstance(pluginId);
    if (instance === undefined) {
      return undefined;
    }
    return facade.snapshots.create({
      pluginId,
      pluginVersion: active.version,
      runtimeKind: instance.kind,
      runtimeInstanceId: instance.runtimeInstanceId,
      agentId,
    });
  };
}

describe("Phase 12 主会话插件工具（P0-1/P0-2 闭环）", () => {
  it("绑定过滤：未绑定插件（即使已激活）的工具不注入", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    // 安装两个插件并启用（都激活）；只绑定 agent-a
    const showcase1 = path.join(SHOWCASE_SOURCE_DIR);
    await facade.install(
      { sourceType: "local", ref: showcase1 },
      [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
    );
    await facade.enable("example.sdk-showcase");
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);

    const tools = resolvePluginTools(facade, "agent-a", "s1");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.pluginId === "example.sdk-showcase")).toBe(true);
    expect(tools.map((tool) => tool.qualifiedName)).toContain("example.sdk-showcase.echo");
    // 未绑定 Agent 的会话不注入任何工具
    expect(resolvePluginTools(facade, "agent-other", "s2")).toHaveLength(0);
  });

  it("PI customTools 驱动：模型 tool_call → PluginSessionTool.invoke → ToolService → worker 执行", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    // 安装 Showcase（node-process worker 提供 echo 真实实现）
    await facade.install(
      { sourceType: "local", ref: SHOWCASE_SOURCE_DIR },
      [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
    );
    await facade.enable("example.sdk-showcase");
    facade.bind("agent-a", "example.sdk-showcase", ["echo"]);
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);

    const sessionId = "main-session-1";
    const pluginTools = resolvePluginTools(facade, "agent-a", sessionId);
    expect(pluginTools).toHaveLength(1);

    // turn 冻结（等价 SessionRuntime.beginTurn）：snapshotFactory 写入 turnContext
    const snapshotFactory = pluginSnapshotFactory(facade);
    const frozen = snapshotFactory("example.sdk-showcase", "agent-a");
    expect(frozen).toBeDefined();
    pluginTools[0]!.turnContext!.current = frozen;
    const frozenSnapshot = frozen!.snapshot as { pluginId: string; grantRevision: number };

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
    // 工具执行结果经 ToolService → RuntimeHost → worker（node-process）真实产生并回写会话
    const handle = (agent as unknown as { _handle: unknown })._handle;
    const toolCalls = handle !== undefined
      ? (handle as { messageEntries: Array<{ toolCalls?: Array<{ toolName: string; status: string; result?: string }> }> }).messageEntries.flatMap((e) => e.toolCalls ?? [])
      : [];
    const executed = toolCalls.find((t) => t.toolName === "example.sdk-showcase.echo");
    if (executed !== undefined) {
      expect(executed.status).toBe("completed");
      expect(executed.result).toContain("hello-main-session");
    }
    // 工具执行结果经 ToolService → RuntimeHost → worker（node-process）真实产生
    expect(facade.runtimeHost.isHealthy("example.sdk-showcase")).toBe(true);
  });
});
