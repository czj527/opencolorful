import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { McpRuntime } from "../../src/runtime/plugins/runtimes/mcp-runtime.js";

// ═══════════════════════════════════════════════════════════════
// T4 MCP Runtime（plans/phase-12.md §9.1 / §12.5）
// - MCP Server 子进程（stdio）；initialize → notifications/initialized；
// - 工具调用转 tools/call；超时/取消；isError → mcp-error；
// - 崩溃（非预期 exit）回调 onExit。
// ═══════════════════════════════════════════════════════════════

const MCP_SERVER = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") { /* ok */ }
    return;
  }
  const id = msg.id;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-mcp", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "mcp_hello", description: "Say hello", inputSchema: { type: "object", properties: { name: { type: "string" } } } }] } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    if (name === "mcp_hello") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "hello " + (args?.name ?? "world") }], isError: false } });
    } else if (name === "mcp_fail") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    } else if (name === "mcp_slow") {
      setTimeout(() => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "slow done" }], isError: false } }), 500);
    } else if (name === "mcp_never") {
      // no response
    } else if (name === "mcp_exit") {
      process.exit(3);
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
    }
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
});
`;

const temporaryDirectories: string[] = [];

interface McpEnv {
  versionDir: string;
  carriers: CarrierRegistry;
  exits: Array<{ code: number | null; signal: string | null }>;
}

function createEnv(): McpEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mcp-runtime-"));
  temporaryDirectories.push(dir);
  const versionDir = path.join(dir, "version");
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, "server.mjs"), MCP_SERVER, "utf8");
  return { versionDir, carriers: new CarrierRegistry(), exits: [] };
}

function makeRuntime(env: McpEnv, overrides: Record<string, unknown> = {}): McpRuntime {
  return new McpRuntime({
    pluginId: "example.mcp",
    version: "1.0.0",
    runtimeInstanceId: "runtime-example.mcp-1",
    versionDir: env.versionDir,
    entry: "server.mjs",
    carriers: env.carriers,
    onExit: (info) => {
      env.exits.push(info);
    },
    onOutput: () => undefined,
    ...overrides,
  });
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("McpRuntime MCP Server 子进程", () => {
  it("start 握手成功 → running，listTools 返回工具", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    expect(runtime.state).toBe("running");
    expect(runtime.isHealthy()).toBe(true);
    const tools = await runtime.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["mcp_hello"]);
    await runtime.stop("shutdown");
  });

  it("工具调用转 tools/call 成功", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.mcp",
      runtimeInstanceId: "runtime-example.mcp-1",
      operationId: "exec-mcp-1",
    });
    const result = await runtime.invoke({
      operationId: "exec-mcp-1",
      method: "mcp_hello",
      params: { name: "OpenColorful" },
      carrier,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ isError: false });
    }
    await runtime.stop("shutdown");
  });

  it("MCP isError=true → mcp-error", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.mcp",
      runtimeInstanceId: "runtime-example.mcp-1",
      operationId: "exec-mcp-2",
    });
    const result = await runtime.invoke({ operationId: "exec-mcp-2", method: "mcp_fail", carrier });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("mcp-error");
      expect(result.message).toMatch(/it broke/);
    }
    await runtime.stop("shutdown");
  });

  it("超时：mcp_slow + timeoutMs → code timeout", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.mcp",
      runtimeInstanceId: "runtime-example.mcp-1",
      operationId: "exec-mcp-3",
    });
    const result = await runtime.invoke({
      operationId: "exec-mcp-3",
      method: "mcp_slow",
      carrier,
      timeoutMs: 120,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
    await runtime.stop("shutdown");
  });

  it("取消：mcp_never + AbortSignal → code cancelled", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const controller = new AbortController();
    const carrier = env.carriers.issue({
      pluginId: "example.mcp",
      runtimeInstanceId: "runtime-example.mcp-1",
      operationId: "exec-mcp-4",
    });
    const promise = runtime.invoke({
      operationId: "exec-mcp-4",
      method: "mcp_never",
      carrier,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
    }
    await runtime.stop("shutdown");
  });

  it("崩溃：mcp_exit 非预期退出 → onExit 回调", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.mcp",
      runtimeInstanceId: "runtime-example.mcp-1",
      operationId: "exec-mcp-5",
    });
    await runtime.invoke({ operationId: "exec-mcp-5", method: "mcp_exit", carrier });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(env.exits.length).toBeGreaterThan(0);
    expect(env.exits[0]?.code).toBe(3);
  });

  it("stop 优雅关闭：不再触发 onExit", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    await runtime.stop("shutdown");
    expect(runtime.isHealthy()).toBe(false);
    expect(env.exits.length).toBe(0);
  });

  it("握手超时（无响应 server）→ 启动失败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mcp-silent-"));
    temporaryDirectories.push(dir);
    const versionDir = path.join(dir, "version");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(
      path.join(versionDir, "server.mjs"),
      'import readline from "node:readline";\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", () => {});\n',
      "utf8",
    );
    const runtime = new McpRuntime({
      pluginId: "example.mcp",
      version: "1.0.0",
      runtimeInstanceId: "runtime-example.mcp-1",
      versionDir,
      entry: "server.mjs",
      carriers: new CarrierRegistry(),
      onExit: () => undefined,
      onOutput: () => undefined,
      handshakeTimeoutMs: 300,
      shutdownGraceMs: 200,
    });
    await expect(runtime.start()).rejects.toThrow();
  });
});
