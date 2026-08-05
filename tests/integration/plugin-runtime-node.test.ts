import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { NodeRuntime } from "../../src/runtime/plugins/runtimes/node-runtime.js";

// ═══════════════════════════════════════════════════════════════
// T4 Node Process Runtime（plans/phase-12.md §9.1 / §9.2）
// - 独立 Node 子进程 JSON-RPC/stdio；握手、调用、超时、崩溃、优雅停止；
// - 崩溃（非预期 exit）回调 onExit 交给 RuntimeHost 判定重启。
// ═══════════════════════════════════════════════════════════════

const WORKER = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) {
    if (msg.method === "runtime.shutdown") { process.exit(0); }
    if (msg.method === "cancel" || msg.method === "cancel-operation") { /* ignore */ }
    return;
  }
  const id = msg.id;
  if (msg.method === "runtime.initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, ok: true } });
  } else if (msg.method === "echo") {
    send({ jsonrpc: "2.0", id, result: { echo: msg.params, pid: process.pid } });
  } else if (msg.method === "slow") {
    setTimeout(() => send({ jsonrpc: "2.0", id, result: { slow: true } }), 400);
  } else if (msg.method === "never") {
    // no response
  } else if (msg.method === "boom") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom failed" } });
  } else if (msg.method === "crash") {
    process.exit(7);
  } else if (msg.method === "spam") {
    for (let i = 0; i < 300; i++) {
      process.stderr.write("spam line " + i + " sk-abcdef1234567890\n");
    }
    send({ jsonrpc: "2.0", id, result: { spam: true } });
  } else if (msg.method === "notify-back") {
    send({ jsonrpc: "2.0", method: "plugin.ping", params: { from: "worker" }, carrier: msg.carrier });
    send({ jsonrpc: "2.0", id, result: { notified: true } });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
});
`;

const WORKER_WITH_HOST_REQUEST = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const pendingHost = {};
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) {
    if (msg.method === "runtime.shutdown") { process.exit(0); }
    return;
  }
  const id = msg.id;
  if (msg.method === undefined) {
    // host 对 worker 主动请求的响应（result 或 error）
    const cb = pendingHost[msg.id];
    if (cb !== undefined) { delete pendingHost[msg.id]; cb(msg); }
    return;
  }
  if (msg.method === "runtime.initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, ok: true } });
  } else if (msg.method === "ask-host") {
    const rid = "w-" + Math.random().toString(16).slice(2, 10);
    pendingHost[rid] = (resp) => send({ jsonrpc: "2.0", id, result: { host: resp.result ?? resp.error } });
    send({ jsonrpc: "2.0", id: rid, method: "host.ping", params: { from: "worker" }, carrier: msg.carrier });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
});
`;

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

interface NodeEnv {
  versionDir: string;
  carriers: CarrierRegistry;
  exits: Array<{ code: number | null; signal: string | null }>;
  outputChunks: string[];
  waitForExit: Promise<void>;
  resolveExit: () => void;
}

function createEnv(workerCode = WORKER, entryName = "worker.mjs"): NodeEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-node-runtime-"));
  temporaryDirectories.push(dir);
  const versionDir = path.join(dir, "version");
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, entryName), workerCode, "utf8");
  const exits: Array<{ code: number | null; signal: string | null }> = [];
  const outputChunks: string[] = [];
  let resolveExit: () => void = () => undefined;
  const waitForExit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  return { versionDir, carriers: new CarrierRegistry(), exits, outputChunks, waitForExit, resolveExit };
}

function makeRuntime(env: NodeEnv, overrides: Record<string, unknown> = {}): NodeRuntime {
  return new NodeRuntime({
    pluginId: "example.node",
    version: "1.0.0",
    runtimeInstanceId: "runtime-example.node-1",
    versionDir: env.versionDir,
    entry: "worker.mjs",
    carriers: env.carriers,
    onExit: (info) => {
      env.exits.push(info);
      env.resolveExit();
    },
    onOutput: (chunk) => {
      env.outputChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    },
    ...overrides,
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("NodeRuntime 独立子进程", () => {
  it("start 握手成功 → running 且健康", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    expect(runtime.state).toBe("running");
    expect(runtime.isHealthy()).toBe(true);
    expect(runtime.kind).toBe("node-process");
    await runtime.stop("shutdown");
  });

  it("invoke 往返成功（真实子进程）", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-1",
    });
    const result = await runtime.invoke({
      operationId: "exec-1",
      method: "echo",
      params: { hello: "world" },
      carrier,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ echo: { hello: "world" } });
    }
    await runtime.stop("shutdown");
  });

  it("worker 返回 error → code protocol-error", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-2",
    });
    const result = await runtime.invoke({ operationId: "exec-2", method: "boom", carrier });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("protocol-error");
      expect(result.message).toMatch(/boom/);
    }
    await runtime.stop("shutdown");
  });

  it("超时：never 方法 → code timeout", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-3",
    });
    const result = await runtime.invoke({
      operationId: "exec-3",
      method: "never",
      carrier,
      timeoutMs: 120,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
    await runtime.stop("shutdown");
  });

  it("取消：AbortSignal → code cancelled", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const controller = new AbortController();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-4",
    });
    const promise = runtime.invoke({ operationId: "exec-4", method: "slow", carrier, signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
    }
    await runtime.stop("shutdown");
  });

  it("崩溃：非预期退出 → onExit 回调 + in-flight 调用返回 connection-closed", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-crash",
    });
    const result = await runtime.invoke({ operationId: "exec-crash", method: "crash", carrier });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["connection-closed", "cancelled", "internal"]).toContain(result.code);
    }
    await Promise.race([env.waitForExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    expect(env.exits.length).toBeGreaterThan(0);
    expect(env.exits[0]?.code).toBe(7);
    expect(runtime.isHealthy()).toBe(false);
  });

  it("stderr 输出走 onOutput（不进入协议通道）", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-spam",
    });
    const result = await runtime.invoke({ operationId: "exec-spam", method: "spam", carrier });
    expect(result.ok).toBe(true);
    expect(env.outputChunks.length).toBeGreaterThan(0);
    await runtime.stop("shutdown");
  });

  it("worker 回传 carrier 的通知被一次性消费；重复被拒", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-notify",
    });
    // 手动模拟：worker 通知携带 carrier → consume 成功；重复 consume 失败
    expect(env.carriers.consume(carrier)).toEqual({ ok: true });
    const again = env.carriers.consume(carrier);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("already-consumed");
    }
    await runtime.stop("shutdown");
  });

  it("入口超出版本目录 → 构造抛错", () => {
    const env = createEnv();
    expect(() =>
      new NodeRuntime({
        pluginId: "example.node",
        version: "1.0.0",
        runtimeInstanceId: "runtime-example.node-1",
        versionDir: env.versionDir,
        entry: "../escape.js",
        carriers: env.carriers,
        onExit: () => undefined,
        onOutput: () => undefined,
      }),
    ).toThrow(/超出版本目录/);
  });

  it("worker 主动请求经 onWorkerRequest 转发（携带 carrier）", async () => {
    const env = createEnv(WORKER_WITH_HOST_REQUEST);
    const received: Array<{ method: string; params?: unknown; carrier?: unknown }> = [];
    const runtime = makeRuntime(env, {
      onWorkerRequest: (message: import("../../src/runtime/plugins/runtimes/json-rpc.js").JsonRpcWorkerRequest) => {
        received.push(message);
        return { forwarded: true, method: message.method };
      },
    });
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-ask",
    });
    const result = await runtime.invoke({ operationId: "exec-ask", method: "ask-host", carrier });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ host: { forwarded: true, method: "host.ping" } });
    }
    expect(received.length).toBe(1);
    expect(received[0]?.method).toBe("host.ping");
    expect(received[0]?.params).toEqual({ from: "worker" });
    // carrier 原样透传给桥接层（由 RuntimeHost 校验/单次消费）
    expect(received[0]?.carrier).toEqual(carrier);
    await runtime.stop("shutdown");
  });

  it("issue 携带 agentId/sessionId → carrier 携带上下文并经 worker 原样回传", async () => {
    const env = createEnv(WORKER_WITH_HOST_REQUEST);
    const received: Array<{ method: string; params?: unknown; carrier?: unknown }> = [];
    const runtime = makeRuntime(env, {
      onWorkerRequest: (message: import("../../src/runtime/plugins/runtimes/json-rpc.js").JsonRpcWorkerRequest) => {
        received.push(message);
        return { forwarded: true, method: message.method };
      },
    });
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-ask-ctx",
      agentId: "agent-1",
      sessionId: "session-1",
    });
    // 签发的 carrier 携带 Agent/Session 上下文（随 token 绑定）
    expect(carrier.agentId).toBe("agent-1");
    expect(carrier.sessionId).toBe("session-1");
    const result = await runtime.invoke({ operationId: "exec-ask-ctx", method: "ask-host", carrier });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ host: { forwarded: true, method: "host.ping" } });
    }
    expect(received.length).toBe(1);
    // worker 原样回传 carrier，上下文不丢失（由 RuntimeHost 校验后传给 broker.call）
    expect((received[0]?.carrier as { agentId?: string; sessionId?: string } | undefined)?.agentId).toBe("agent-1");
    expect((received[0]?.carrier as { agentId?: string; sessionId?: string } | undefined)?.sessionId).toBe("session-1");
    await runtime.stop("shutdown");
  });

  it("未注入 onWorkerRequest 时 worker 主动请求 → method-not-found 回写 worker", async () => {
    const env = createEnv(WORKER_WITH_HOST_REQUEST);
    const runtime = makeRuntime(env);
    await runtime.start();
    const carrier = env.carriers.issue({
      pluginId: "example.node",
      runtimeInstanceId: "runtime-example.node-1",
      operationId: "exec-ask-nohandler",
    });
    const result = await runtime.invoke({ operationId: "exec-ask-nohandler", method: "ask-host", carrier });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ host: { code: -32601 } });
    }
    await runtime.stop("shutdown");
  });

  it("stop 优雅关闭：进程退出且不再触发 onExit", async () => {
    const env = createEnv();
    const runtime = makeRuntime(env);
    await runtime.start();
    await runtime.stop("plugin_disabled");
    expect(runtime.state).toBe("stopped");
    expect(runtime.isHealthy()).toBe(false);
    expect(env.exits.length).toBe(0); // 主动停止不回调 onExit
  });
});

describe("NodeRuntime 启动失败", () => {
  it("入口不存在 → 启动失败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-node-missing-"));
    temporaryDirectories.push(dir);
    const versionDir = path.join(dir, "version");
    fs.mkdirSync(versionDir, { recursive: true });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const runtime = new NodeRuntime({
      pluginId: "example.node",
      version: "1.0.0",
      runtimeInstanceId: "runtime-example.node-1",
      versionDir,
      entry: "missing.mjs",
      carriers: new CarrierRegistry(),
      onExit: (info) => {
        exits.push(info);
      },
      onOutput: () => undefined,
      handshakeTimeoutMs: 300,
      shutdownGraceMs: 200,
    });
    await expect(runtime.start()).rejects.toThrow();
    expect(runtime.isHealthy()).toBe(false);
  });

  it("worker 协议版本不匹配 → 启动失败", async () => {
    const env = createEnv(WORKER.replace("protocolVersion: 1", "protocolVersion: 99"));
    const runtime = makeRuntime(env, { handshakeTimeoutMs: 500 });
    await expect(runtime.start()).rejects.toThrow(/协议版本不匹配/);
  });
});
