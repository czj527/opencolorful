import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { JsonRpcClient, RpcCancelledError, RpcRequestError, RpcTimeoutError } from "../../src/runtime/plugins/runtimes/json-rpc.js";

// ═══════════════════════════════════════════════════════════════
// T4 版本化 JSON-RPC/stdio（plans/phase-12.md §9.2）
// - 行帧、1MB 上限、超时、取消、通知、worker 请求响应；
// - 端到端用真实 Node 子进程 stdio 验证。
// ═══════════════════════════════════════════════════════════════

const WORKER = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) {
    if (msg.method === "shutdown") { process.exit(0); }
    return;
  }
  const id = msg.id;
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  if (msg.method === "echo") {
    send({ jsonrpc: "2.0", id, result: msg.params });
  } else if (msg.method === "error") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "kaboom" } });
  } else if (msg.method === "notify") {
    send({ jsonrpc: "2.0", method: "plugin.ping", params: msg.params, carrier: msg.carrier });
    send({ jsonrpc: "2.0", id, result: { notified: true } });
  } else if (msg.method === "delay") {
    setTimeout(() => send({ jsonrpc: "2.0", id, result: { delayed: true } }), 300);
  } else if (msg.method === "never") {
    // no response
  } else if (msg.method === "garbage") {
    process.stdout.write("this-is-not-json\n");
    send({ jsonrpc: "2.0", id, result: { after: true } });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
});
`;

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function spawnWorker(code: string, extraOptions: { onNotification?: (m: unknown) => void } = {}): JsonRpcClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-jsonrpc-"));
  tempDirs.push(dir);
  const file = path.join(dir, "worker.mjs");
  fs.writeFileSync(file, code, "utf8");
  const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  const client = new JsonRpcClient({
    transport: { stdin: child.stdin as NodeJS.WritableStream, stdout: child.stdout as NodeJS.ReadableStream },
    ...(extraOptions.onNotification !== undefined ? { onNotification: extraOptions.onNotification } : {}),
  });
  return client;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
});

describe("JsonRpcClient stdio 编解码", () => {
  it("request 请求/响应成功", async () => {
    const client = spawnWorker(WORKER);
    const result = await client.request("echo", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
    client.close();
  });

  it("worker 返回 error → 拒绝（协议错误）", async () => {
    const client = spawnWorker(WORKER);
    await expect(client.request("error")).rejects.toMatchObject({ code: "protocol-error", message: /kaboom/ });
    client.close();
  });

  it("未知方法 → 拒绝", async () => {
    const client = spawnWorker(WORKER);
    await expect(client.request("no-such-method")).rejects.toMatchObject({ code: "protocol-error", message: /unknown/ });
    client.close();
  });

  it("超时：never 方法 + timeoutMs → RpcTimeoutError，且不影响后续请求", async () => {
    const client = spawnWorker(WORKER);
    await expect(client.request("never", {}, { timeoutMs: 150 })).rejects.toBeInstanceOf(RpcTimeoutError);
    // pending 已清理，后续请求仍可用
    const result = await client.request("echo", { ok: true });
    expect(result).toEqual({ ok: true });
    expect(client.getPendingCount()).toBe(0);
    client.close();
  });

  it("取消：AbortSignal abort → RpcCancelledError", async () => {
    const client = spawnWorker(WORKER);
    const controller = new AbortController();
    const promise = client.request("delay", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(RpcCancelledError);
    client.close();
  });

  it("收到 worker 通知（携带 carrier）", async () => {
    const notifications: unknown[] = [];
    const client = spawnWorker(WORKER, { onNotification: (m) => notifications.push(m) });
    const carrier = {
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-1",
      operationId: "exec-1",
      token: "tok-" + "x".repeat(40),
      traceId: "t1",
      spanId: "s1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await client.request("notify", { ping: true }, { carrier });
    expect(notifications.length).toBe(1);
    const notification = notifications[0] as { method: string; carrier: unknown };
    expect(notification.method).toBe("plugin.ping");
    expect(notification.carrier).toEqual(carrier);
    client.close();
  });

  it("stdout 出现非法 JSON → 全部 pending 以 protocol-error 拒绝", async () => {
    const client = spawnWorker(WORKER);
    const promise = client.request("garbage");
    await expect(promise).rejects.toMatchObject({ code: "protocol-error" });
    client.close();
  });
});

describe("JsonRpcClient 帧上限与双向消息", () => {
  it("接收超长帧 → protocol-error 拒绝", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonRpcClient({ transport: { stdin, stdout }, maxFrameBytes: 1_024 });
    const promise = client.request("echo", {});
    stdout.write(`${"x".repeat(5_000)}\n`);
    await expect(promise).rejects.toMatchObject({ code: "protocol-error" });
    client.close();
  });

  it("发送超长帧 → oversize-frame 拒绝", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonRpcClient({ transport: { stdin, stdout }, maxFrameBytes: 1_024 });
    const promise = client.request("echo", { big: "x".repeat(2_000) });
    await expect(promise).rejects.toMatchObject({ code: "oversize-frame" });
    client.close();
  });

  it("worker 主动请求 → 平台回 method-not-found（双向 JsonRpcClient 连接）", async () => {
    const aIn = new PassThrough();
    const aOut = new PassThrough();
    const bIn = new PassThrough();
    const bOut = new PassThrough();
    aIn.pipe(bOut);
    bIn.pipe(aOut);
    const host = new JsonRpcClient({ transport: { stdin: aIn, stdout: aOut } });
    const worker = new JsonRpcClient({ transport: { stdin: bIn, stdout: bOut } });
    // worker 请求 host，host 无 onRequest → method-not-found
    await expect(worker.request("host.domain-op", { data: 1 })).rejects.toMatchObject({ code: "protocol-error", message: /worker 主动请求/ });
    host.close();
    worker.close();
  });
});

describe("JsonRpcClient worker 主动请求（onRequest 注入）", () => {
  function connectHost(onRequest: (message: { id: number | string; method: string; params?: unknown; carrier?: unknown }) => unknown) {
    const aIn = new PassThrough();
    const aOut = new PassThrough();
    const bIn = new PassThrough();
    const bOut = new PassThrough();
    aIn.pipe(bOut);
    bIn.pipe(aOut);
    const host = new JsonRpcClient({ transport: { stdin: aIn, stdout: aOut }, onRequest });
    const worker = new JsonRpcClient({ transport: { stdin: bIn, stdout: bOut } });
    return { host, worker };
  }

  it("注入 onRequest：worker 主动请求 → 结果回写 result 响应", async () => {
    const { host, worker } = connectHost(async (message) => {
      expect(message.method).toBe("host.ping");
      expect(message.params).toEqual({ from: "worker" });
      return { pong: true, echoId: message.id };
    });
    const result = await worker.request("host.ping", { from: "worker" });
    expect(result).toEqual({ pong: true, echoId: expect.any(Number) });
    host.close();
    worker.close();
  });

  it("worker 请求携带 carrier → onRequest 收到完整 carrier（透传身份供上层校验）", async () => {
    const seen: Array<{ method: string; carrier?: unknown }> = [];
    const { host, worker } = connectHost((message) => {
      seen.push(message);
      return { ok: true };
    });
    const carrier = {
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-1",
      operationId: "exec-1",
      token: "tok-" + "x".repeat(40),
      traceId: "t1",
      spanId: "s1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const result = await worker.request("host.ping", {}, { carrier });
    expect(result).toEqual({ ok: true });
    expect(seen.length).toBe(1);
    expect(seen[0]?.carrier).toEqual(carrier);
    host.close();
    worker.close();
  });

  it("worker 请求携带带 agentId/sessionId 的 carrier → onRequest 原样收到（上下文不丢失）", async () => {
    const seen: Array<{ method: string; carrier?: unknown }> = [];
    const { host, worker } = connectHost((message) => {
      seen.push(message);
      return { ok: true };
    });
    const carrier = {
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-1",
      operationId: "exec-1",
      token: "tok-" + "x".repeat(40),
      traceId: "t1",
      spanId: "s1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      agentId: "agent-1",
      sessionId: "session-1",
    };
    const result = await worker.request("host.ping", {}, { carrier });
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.carrier).toEqual(carrier);
    host.close();
    worker.close();
  });

  it("旧格式 carrier（无 agentId/sessionId）仍可传输（协议向后兼容）", async () => {
    const seen: Array<{ method: string; carrier?: unknown }> = [];
    const { host, worker } = connectHost((message) => {
      seen.push(message);
      return { ok: true };
    });
    const carrier = {
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-1",
      operationId: "exec-1",
      token: "tok-" + "x".repeat(40),
      traceId: "t1",
      spanId: "s1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const result = await worker.request("host.ping", {}, { carrier });
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.carrier).toEqual(carrier);
    expect((seen[0]?.carrier as { agentId?: string }).agentId).toBeUndefined();
    host.close();
    worker.close();
  });

  it("onRequest 抛 RpcRequestError → 回写对应错误码与消息", async () => {
    const { host, worker } = connectHost(() => {
      throw new RpcRequestError(-32600, "worker 请求缺少 carrier，拒绝");
    });
    await expect(worker.request("host.ping")).rejects.toMatchObject({ code: "protocol-error", message: /缺少 carrier/ });
    host.close();
    worker.close();
  });

  it("onRequest 抛普通错误 → 按 internal-error 回写", async () => {
    const { host, worker } = connectHost(() => {
      throw new Error("handler boom");
    });
    await expect(worker.request("host.ping")).rejects.toMatchObject({ code: "protocol-error", message: /internal-error|handler boom/ });
    host.close();
    worker.close();
  });

  it("handler 返回 undefined → 成功回写 result: null", async () => {
    const { host, worker } = connectHost(() => undefined);
    const result = await worker.request("host.ping");
    expect(result).toBeNull();
    host.close();
    worker.close();
  });
});

describe("JsonRpcClient 关闭语义", () => {
  it("close 后发送请求 → connection-closed", async () => {
    const client = spawnWorker(WORKER);
    client.close();
    await expect(client.request("echo", {})).rejects.toMatchObject({ code: "connection-closed" });
  });

  it("stdout 结束后 pending 以 connection-closed 拒绝", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonRpcClient({ transport: { stdin, stdout } });
    const promise = client.request("echo", {});
    stdout.end();
    await expect(promise).rejects.toMatchObject({ code: "connection-closed" });
  });
});
