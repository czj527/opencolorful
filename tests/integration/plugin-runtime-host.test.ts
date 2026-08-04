import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { PluginRegistry } from "../../src/runtime/plugins/registry/plugin-registry.js";
import { PluginInstaller } from "../../src/runtime/plugins/installer/plugin-installer.js";
import { HostBroker } from "../../src/runtime/plugins/grants/host-broker.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { RuntimeHost } from "../../src/runtime/plugins/runtimes/runtime-host.js";
import type {
  PluginRuntime,
  RuntimeFactory,
  RuntimeInvokeInput,
  RuntimeInvokeResult,
  RuntimeStatus,
} from "../../src/runtime/plugins/runtimes/runtime-host.js";
import { StreamCapture } from "../../src/runtime/plugins/runtimes/stream-capture.js";
import { resolvePythonInterpreter, PythonRuntime } from "../../src/runtime/plugins/runtimes/python-runtime.js";

// ═══════════════════════════════════════════════════════════════
// T4 Runtime Host 集成（plans/phase-12.md §9.2 / §17.6）
// - 实例生命周期、崩溃检测 + restart budget、safe shutdown、update handoff；
// - plugin.process.* / plugin.execution.* 自动记录（含 interrupted 终态）；
// - 取消 reasonCode 稳定（plugin_updated 等），不伪装用户 Abort；
// - Python 解释器发现（无 python 时跳过）；
// - StreamCapture 捕获管线（脱敏/折叠/限长/限速）。
// ═══════════════════════════════════════════════════════════════

const NODE_WORKER = String.raw`
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
  } else if (msg.method === "echo") {
    send({ jsonrpc: "2.0", id, result: { echo: msg.params, pid: process.pid } });
  } else if (msg.method === "slow") {
    setTimeout(() => send({ jsonrpc: "2.0", id, result: { slow: true } }), 500);
  } else if (msg.method === "never") {
    // no response
  } else if (msg.method === "crash") {
    process.exit(7);
  } else if (msg.method === "ask-host") {
    const rid = "w-" + Math.random().toString(16).slice(2, 10);
    pendingHost[rid] = (resp) => send({ jsonrpc: "2.0", id, result: { host: resp.result ?? resp.error } });
    send({ jsonrpc: "2.0", id: rid, method: "host.ping", params: { from: "worker" }, carrier: msg.carrier });
  } else if (msg.method === "ask-host-forged") {
    // 伪造 carrier：token 未签发 → Host 桥接应拒绝
    const rid = "w-" + Math.random().toString(16).slice(2, 10);
    pendingHost[rid] = (resp) => send({ jsonrpc: "2.0", id, result: { host: resp.result ?? resp.error } });
    send({ jsonrpc: "2.0", id: rid, method: "host.ping", params: {}, carrier: { ...msg.carrier, token: "forged-token-" + "x".repeat(20) } });
  } else if (msg.method === "ask-host-no-carrier") {
    const rid = "w-" + Math.random().toString(16).slice(2, 10);
    pendingHost[rid] = (resp) => send({ jsonrpc: "2.0", id, result: { host: resp.result ?? resp.error } });
    send({ jsonrpc: "2.0", id: rid, method: "host.ping", params: {} });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }
});
`;

const PYTHON_WORKER = String.raw`
import sys, json
def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if "id" not in msg:
        if msg.get("method") == "runtime.shutdown":
            break
        continue
    mid = msg["id"]
    method = msg.get("method")
    if method == "runtime.initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "ok": True}})
    elif method == "echo":
        send({"jsonrpc": "2.0", "id": mid, "result": {"echo": msg.get("params")}})
    elif method == "boom":
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": "python boom"}})
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown"}})
`;

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const openHosts: RuntimeHost[] = [];

interface Env {
  db: Database.Database;
  broker: HostBroker;
  carriers: CarrierRegistry;
  host: RuntimeHost;
  paths: ReturnType<typeof getRuntimePaths>;
  store: PluginRegistryStore;
}

function createEnv(
  pluginId: string,
  runtimeKind: "node-process" | "python-process",
  overrides: { budget?: { maxCrashes?: number; windowMs?: number }; pythonInterpreter?: string; runtimeFactory?: RuntimeFactory } = {},
): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-runtime-host-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  const producer: ProducerContext = {
    component: "runtime-host-test",
    processType: "server",
    processId: "1",
    bootId: "boot-host",
    appVersion: "0.0.0-test",
    hostPlatform: process.platform,
  };
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(dir, "logs"),
    spoolRoot: path.join(dir, "spool"),
  });
  instrument.init(context);

  const installer = new PluginInstaller({ paths, adapters: [], hostVersion: "1.0.0" });
  const store = new PluginRegistryStore(db);
  const registry = new PluginRegistry({ store, installer, paths, audit: context.audit });
  const grantStore = new PluginGrantStore(db);
  const bindingStore = new PluginBindingStore(db);
  const policy = new EffectivePolicy({ grants: grantStore, bindings: bindingStore });
  const broker = new HostBroker({ policy });
  const carriers = new CarrierRegistry();
  const host = new RuntimeHost({
    paths,
    registry,
    broker,
    carriers,
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.pythonInterpreter !== undefined ? { pythonInterpreter: overrides.pythonInterpreter } : {}),
    ...(overrides.runtimeFactory !== undefined ? { runtimeFactory: overrides.runtimeFactory } : {}),
  });
  openHosts.push(host);

  const versionDir = path.join(paths.pluginsInstalled, pluginId, "1.0.0");
  fs.mkdirSync(versionDir, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: pluginId,
    name: "Host Fixture",
    version: "1.0.0",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "full-access",
    runtime: { kind: runtimeKind, entry: runtimeKind === "node-process" ? "worker.mjs" : "worker.py" },
    permissions: [],
    contributions: {},
  };
  fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(
    path.join(versionDir, runtimeKind === "node-process" ? "worker.mjs" : "worker.py"),
    runtimeKind === "node-process" ? NODE_WORKER : PYTHON_WORKER,
    "utf8",
  );
  store.saveInstallation({
    pluginId,
    version: "1.0.0",
    active: true,
    status: "enabled",
    sourceType: "local",
    sourceRef: "file://fixture",
    sourceVersion: null,
    artifactSha256: "abc",
    artifactSize: 1,
    provenance: {},
    manifest,
    installedAt: new Date().toISOString(),
  });
  return { db, broker, carriers, host, paths, store };
}

function queryActivity(db: Database.Database, eventName: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT event_name, status, operation_id, payload_json FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<Record<string, unknown>>;
}

async function waitFor<T>(producer: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = producer();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error("waitFor 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const PLUGIN = "example.host";

afterEach(async () => {
  instrument.reset();
  await Promise.allSettled(openHosts.splice(0).map((host) => host.stopAll("shutdown")));
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

describe("RuntimeHost 生命周期（node-process）", () => {
  it("start → invoke → stop，process.* 与 execution.* 事件齐全", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process");
    const instance = await host.start(PLUGIN);
    expect(instance.status).toBe("running");
    expect(instance.kind).toBe("node-process");
    const procStarted = queryActivity(db, "plugin.process.started");
    expect(procStarted).toHaveLength(1);

    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "echo",
      method: "echo",
      params: { value: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ echo: { value: 1 } });
    }
    expect(queryActivity(db, "plugin.execution.started")).toHaveLength(1);
    expect(queryActivity(db, "plugin.execution.completed")).toHaveLength(1);

    await host.stop(PLUGIN, "plugin_disabled");
    const procExited = queryActivity(db, "plugin.process.exited");
    expect(procExited).toHaveLength(1);
    expect(host.getInstance(PLUGIN)).toBeUndefined();
  });

  it("isHealthy 反映实例状态", async () => {
    const { host } = createEnv(PLUGIN, "node-process");
    expect(host.isHealthy(PLUGIN)).toBe(false);
    await host.start(PLUGIN);
    expect(host.isHealthy(PLUGIN)).toBe(true);
  });

  it("worker 回传的权威字段/敏感输入不进入 execution payload（Host 重新盖章）", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process");
    await host.start(PLUGIN);
    // worker 把伪造的权威字段与敏感值放进返回结果
    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "echo",
      method: "echo",
      params: { authority: { actor: "forged-user", scope: "forged-scope", trace: "forged-trace", eventId: "forged-event" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ echo: { authority: { actor: "forged-user" } } });
    }
    for (const eventName of ["plugin.execution.started", "plugin.execution.completed"]) {
      const rows = queryActivity(db, eventName);
      for (const row of rows) {
        const payloadJson = JSON.stringify(row.payload_json);
        expect(payloadJson).not.toContain("forged-user");
        expect(payloadJson).not.toContain("forged-scope");
        expect(payloadJson).not.toContain("forged-trace");
        expect(payloadJson).not.toContain("forged-event");
      }
    }
    await host.stop(PLUGIN, "shutdown");
  });
});

describe("RuntimeHost worker 主动请求 → HostBroker 白名单 API", () => {
  it("合法 carrier 的 host.ping 请求 → broker 白名单 API 执行并回写结果", async () => {
    const { host } = createEnv(PLUGIN, "node-process");
    const instance = await host.start(PLUGIN);
    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "ask-host",
      method: "ask-host",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // host.ping 为 HostBroker 内置白名单 API，返回平台签发身份
      expect(result.result).toMatchObject({
        host: { pong: true, pluginId: PLUGIN, runtimeInstanceId: instance.runtimeInstanceId },
      });
    }
    await host.stop(PLUGIN, "shutdown");
  });

  it("伪造 carrier（token 未签发）→ 桥接拒绝且错误回写 worker", async () => {
    const { host } = createEnv(PLUGIN, "node-process");
    await host.start(PLUGIN);
    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "ask-host-forged",
      method: "ask-host-forged",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hostResp = result.result as { host?: { code?: number; message?: string } };
      expect(hostResp.host?.code).toBe(-32600);
      expect(hostResp.host?.message).toMatch(/carrier 校验失败/);
    }
    await host.stop(PLUGIN, "shutdown");
  });

  it("缺少 carrier 的请求 → 明确拒绝（-32600）", async () => {
    const { host } = createEnv(PLUGIN, "node-process");
    await host.start(PLUGIN);
    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "ask-host-no-carrier",
      method: "ask-host-no-carrier",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hostResp = result.result as { host?: { code?: number; message?: string } };
      expect(hostResp.host?.code).toBe(-32600);
      expect(hostResp.host?.message).toMatch(/缺少平台签发的一次性 carrier/);
    }
    await host.stop(PLUGIN, "shutdown");
  });
});

describe("RuntimeHost 崩溃检测与 restart budget", () => {
  it("预算内崩溃 → 重启（新 runtimeInstanceId + process.restarted + 关联旧实例）", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process", { budget: { maxCrashes: 2, windowMs: 60_000 } });
    const first = await host.start(PLUGIN);
    const result = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "crash",
      method: "crash",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 崩溃调用本身可能以 cancelled（宿主同步中止）或 connection-closed 结束
      expect(["cancelled", "connection-closed"]).toContain(result.code);
    }
    const restarted = await waitFor(() => {
      const instance = host.getInstance(PLUGIN);
      if (instance === undefined || instance.attempt !== 2 || instance.status !== "running") return undefined;
      return instance;
    });
    expect(restarted.runtimeInstanceId).not.toBe(first.runtimeInstanceId);
    expect(restarted.linkedFrom).toBe(first.runtimeInstanceId);
    expect(queryActivity(db, "plugin.process.crashed")).toHaveLength(1);
    expect(queryActivity(db, "plugin.process.restarted")).toHaveLength(1);
    expect(queryActivity(db, "plugin.process.started")).toHaveLength(2);
    // 旧实例 broker 身份已吊销
    const ping = await host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "echo",
      method: "echo",
      params: {},
    });
    expect(ping.ok).toBe(true);
    await host.stop(PLUGIN, "shutdown");
  });

  it("超限崩溃 → degraded 停止，不再重启", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process", { budget: { maxCrashes: 1, windowMs: 60_000 } });
    await host.start(PLUGIN);
    // 第一次崩溃 → 重启（attempt 2）
    await host.invoke({ pluginId: PLUGIN, contributionKind: "tool", contributionId: "crash", method: "crash" });
    await waitFor(() => {
      const instance = host.getInstance(PLUGIN);
      if (instance !== undefined && instance.attempt === 2 && instance.status === "running") return instance;
      return undefined;
    });
    // 第二次崩溃 → 超限 degraded
    await host.invoke({ pluginId: PLUGIN, contributionKind: "tool", contributionId: "crash", method: "crash" });
    await waitFor(() => {
      if (host.getInstance(PLUGIN) === undefined) return true;
      return undefined;
    });
    expect(host.getInstance(PLUGIN)).toBeUndefined();
    expect(queryActivity(db, "plugin.process.crashed")).toHaveLength(2);
    expect(queryActivity(db, "plugin.degraded").length).toBeGreaterThanOrEqual(1);
  });

  it("崩溃时 in-flight 执行 → interrupted 终态（reasonCode runtime-crashed）", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process", { budget: { maxCrashes: 3, windowMs: 60_000 } });
    await host.start(PLUGIN);
    const promise = host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "never",
      method: "never",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await host.invoke({ pluginId: PLUGIN, contributionKind: "tool", contributionId: "crash", method: "crash" });
    const result = await promise;
    expect(result.ok).toBe(false);
    await waitFor(() => {
      const rows = queryActivity(db, "plugin.execution.interrupted");
      return rows.length > 0 ? rows : undefined;
    });
    const interrupted = queryActivity(db, "plugin.execution.interrupted");
    expect(interrupted.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(interrupted[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes.reasonCode).toBe("runtime-crashed");
  });
});

describe("RuntimeHost 交接与取消 reasonCode", () => {
  it("update handoff：旧实例停止，取消 in-flight 且 reasonCode=plugin_updated", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process");
    await host.start(PLUGIN);
    const inflight = host.invoke({
      pluginId: PLUGIN,
      contributionKind: "tool",
      contributionId: "slow",
      method: "slow",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await host.handoff(PLUGIN, "plugin_updated");
    const result = await inflight;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
    }
    await waitFor(() => {
      const rows = queryActivity(db, "plugin.execution.cancelled");
      return rows.length > 0 ? rows : undefined;
    });
    const cancelled = queryActivity(db, "plugin.execution.cancelled");
    const payload = JSON.parse(cancelled[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes.reasonCode).toBe("plugin_updated");
    expect(host.getInstance(PLUGIN)).toBeUndefined();
  });

  it("handoff 后再次 start → 新 runtimeInstanceId", async () => {
    const { host } = createEnv(PLUGIN, "node-process");
    const first = await host.start(PLUGIN);
    await host.handoff(PLUGIN, "plugin_updated");
    const second = await host.start(PLUGIN);
    expect(second.runtimeInstanceId).not.toBe(first.runtimeInstanceId);
    expect(second.version).toBe(first.version);
    await host.stop(PLUGIN, "shutdown");
  });

  it("stopAll 关闭全部实例", async () => {
    const { db, host } = createEnv(PLUGIN, "node-process");
    await host.start(PLUGIN);
    await host.stopAll("shutdown");
    expect(host.listInstances()).toHaveLength(0);
    expect(queryActivity(db, "plugin.process.exited").length).toBe(1);
  });

  it("disabled 插件禁止启动", async () => {
    const { host, store } = createEnv(PLUGIN, "node-process");
    store.setStatus(PLUGIN, "1.0.0", "disabled");
    await expect(host.start(PLUGIN)).rejects.toThrow(/disabled/);
    await expect(host.start("example.missing")).rejects.toThrow(/未安装/);
  });
});

describe("PythonRuntime（解释器发现）", () => {
  let pythonAvailable = true;
  try {
    resolvePythonInterpreter();
  } catch {
    pythonAvailable = false;
  }

  const itPy = pythonAvailable ? it : it.skip;

  itPy("resolvePythonInterpreter 返回可用解释器", () => {
    const interpreter = resolvePythonInterpreter();
    expect(typeof interpreter).toBe("string");
    expect(interpreter.length).toBeGreaterThan(0);
  });

  itPy("插件声明不存在的解释器 → PythonInterpreterNotFoundError", () => {
    expect(() => resolvePythonInterpreter(path.join(os.tmpdir(), "no-such-python.exe"))).toThrow(/不存在/);
  });

  itPy("通过 RuntimeHost 启动 python 插件并调用", async () => {
    const { host } = createEnv("example.python", "python-process");
    const instance = await host.start("example.python");
    expect(instance.kind).toBe("python-process");
    expect(instance.runtime).toBeInstanceOf(PythonRuntime);
    const result = await host.invoke({
      pluginId: "example.python",
      contributionKind: "tool",
      contributionId: "echo",
      method: "echo",
      params: { hello: "python" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ echo: { hello: "python" } });
    }
    await host.stop("example.python", "shutdown");
  });
});

// ── 启动竞态修复专用 fake runtime（模拟握手期崩溃 + restart）──────

class HandshakeCrashRuntime implements PluginRuntime {
  readonly kind = "bundle" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly crashOnStart: boolean;
  private readonly onExit: (info: { code: number | null; signal: string | null }) => void;

  constructor(options: {
    pluginId: string;
    version: string;
    runtimeInstanceId: string;
    crashOnStart: boolean;
    onExit: (info: { code: number | null; signal: string | null }) => void;
  }) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.crashOnStart = options.crashOnStart;
    this.onExit = options.onExit;
  }

  async start(): Promise<void> {
    if (this.crashOnStart) {
      // 与真实 child 'exit' 事件一致：先让出事件循环（handleCrash 已完成对 map 的
      // 替换），再触发 onExit 并让本次握手 promise reject
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.onExit({ code: 1, signal: null });
      this.state = "crashed";
      throw new Error("握手期子进程崩溃");
    }
    this.state = "running";
  }

  /** 测试用：模拟运行中的子进程崩溃退出 */
  crashNow(): void {
    this.onExit({ code: 1, signal: null });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }

  async invoke(_input: RuntimeInvokeInput): Promise<RuntimeInvokeResult> {
    return { ok: false, code: "not-running", message: "未运行" };
  }

  cancel(): void {
    // no-op
  }

  isHealthy(): boolean {
    return this.state === "running";
  }
}

describe("RuntimeHost 启动竞态（fake runtime）", () => {
  it("握手期崩溃：start catch 不误删 restart 实例", async () => {
    let created = 0;
    const { host } = createEnv(PLUGIN, "node-process", {
      budget: { maxCrashes: 3, windowMs: 60_000 },
      runtimeFactory: (_ctx, deps) => {
        created += 1;
        return new HandshakeCrashRuntime({
          pluginId: _ctx.pluginId,
          version: _ctx.version,
          runtimeInstanceId: _ctx.runtimeInstanceId,
          crashOnStart: created === 1, // 首个实例握手期崩溃；restart 实例正常
          onExit: deps.onExit,
        });
      },
    });

    // 首次 start：握手期崩溃 → handleCrash → restartInstance（attempt 2）替换 map；
    // start 的 catch 不得误删 restart 实例（旧代码会误删，造成孤儿进程）
    await expect(host.start(PLUGIN)).rejects.toThrow(/握手/);

    const restarted = await waitFor(() => {
      const instance = host.getInstance(PLUGIN);
      if (instance === undefined || instance.attempt !== 2 || instance.status !== "running") return undefined;
      return instance;
    });
    expect(restarted.linkedFrom).toBeDefined();
  });

  it("重启实例启动时再次崩溃：restart catch 不误删二次重启实例", async () => {
    let created = 0;
    const { host } = createEnv(PLUGIN, "node-process", {
      budget: { maxCrashes: 3, windowMs: 60_000 },
      runtimeFactory: (_ctx, deps) => {
        created += 1;
        return new HandshakeCrashRuntime({
          pluginId: _ctx.pluginId,
          version: _ctx.version,
          runtimeInstanceId: _ctx.runtimeInstanceId,
          crashOnStart: created === 2, // 实例 1 正常；实例 2 启动即崩溃；实例 3 正常
          onExit: deps.onExit,
        });
      },
    });

    const first = await host.start(PLUGIN);
    expect(first.attempt).toBe(1);

    // 实例 1 崩溃 → restart 创建实例 2（启动即崩溃）→ 二次 restart 创建实例 3；
    // 实例 2 的 restart catch 不得误删实例 3
    (first.runtime as HandshakeCrashRuntime).crashNow();

    const third = await waitFor(() => {
      const instance = host.getInstance(PLUGIN);
      if (instance === undefined || instance.attempt !== 3 || instance.status !== "running") return undefined;
      return instance;
    });
    expect(third.linkedFrom).toBeDefined();
  });

  it("启动失败（无崩溃）：start catch 正常删除实例", async () => {
    const { host } = createEnv(PLUGIN, "node-process", {
      runtimeFactory: (ctx) => ({
        kind: "bundle",
        pluginId: ctx.pluginId,
        version: ctx.version,
        runtimeInstanceId: ctx.runtimeInstanceId,
        state: "starting",
        start: async () => {
          throw new Error("启动失败");
        },
        stop: async () => {},
        invoke: async (): Promise<RuntimeInvokeResult> => ({ ok: false, code: "not-running", message: "未运行" }),
        cancel: () => {},
        isHealthy: () => false,
      }),
    });

    await expect(host.start(PLUGIN)).rejects.toThrow(/启动失败/);
    expect(host.getInstance(PLUGIN)).toBeUndefined();
  });
});

describe("StreamCapture 捕获管线", () => {
  function makeCapture(overrides: { maxLineBytes?: number; maxLinesPerWindow?: number; windowMs?: number; maxTotalBytes?: number } = {}) {
    const emitted: Array<{ line: string; meta: { repeated: number; truncated: boolean } }> = [];
    const capture = new StreamCapture({
      pluginId: "example.capture",
      runtimeInstanceId: "runtime-1",
      stream: "stderr",
      emit: (line, meta) => emitted.push({ line, meta: { repeated: meta.repeated, truncated: meta.truncated } }),
      ...overrides,
    });
    return { capture, emitted };
  }

  it("脱敏：stdout/stderr 中的凭据与路径被清洗", () => {
    const { capture, emitted } = makeCapture();
    capture.write('Authorization: Bearer sk-abcdef1234567890\n');
    capture.write('error at /Users/secret/file.txt with key sk-abcdef1234567890\n');
    capture.end();
    expect(emitted.length).toBe(2);
    expect(emitted[0]?.line).not.toContain("sk-abcdef1234567890");
    expect(emitted[0]?.line).not.toContain("Bearer");
    expect(emitted[0]?.line).toContain("[AUTH_HEADER]");
    expect(emitted[1]?.line).not.toContain("/Users/secret/file.txt");
    expect(emitted[1]?.line).not.toContain("sk-abcdef1234567890");
  });

  it("每行限长 ≤2KB：超长行截断并标记", () => {
    const { capture, emitted } = makeCapture({ maxLineBytes: 64 });
    capture.write(`${"hello world ".repeat(40)}\n`);
    capture.end();
    expect(emitted.length).toBe(1);
    const line = emitted[0]?.line ?? "";
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(96);
    expect(emitted[0]?.meta.truncated).toBe(true);
    expect(capture.getStats().truncated).toBe(1);
  });

  it("重复折叠：连续相同行合并计数", () => {
    const { capture, emitted } = makeCapture();
    capture.write("a\n");
    capture.write("a\n");
    capture.write("a\n");
    capture.write("b\n");
    capture.end();
    expect(emitted.length).toBe(2);
    expect(emitted[0]?.line).toBe("a");
    expect(emitted[0]?.meta.repeated).toBe(3);
    expect(emitted[1]?.line).toBe("b");
    expect(emitted[1]?.meta.repeated).toBe(1);
    expect(capture.getStats().folded).toBe(2);
  });

  it("限速：窗口内超过上限的行丢弃并计数", () => {
    const { capture, emitted } = makeCapture({ maxLinesPerWindow: 2, windowMs: 60_000 });
    capture.write("l1\nl2\nl3\nl4\n");
    capture.end();
    expect(emitted.length).toBe(2);
    expect(capture.getStats().rateLimited).toBe(2);
  });

  it("总字节预算：超限块整体丢弃并计数", () => {
    const { capture, emitted } = makeCapture({ maxTotalBytes: 32 });
    capture.write("0123456789\n"); // 11 bytes
    capture.write("abcdefghijklmnopqrstuvwxyz\n"); // 27 bytes → 超预算
    capture.end();
    expect(emitted.length).toBe(1);
    expect(capture.getStats().droppedBytes).toBe(27);
  });

  it("多块写入与半行合并", () => {
    const { capture, emitted } = makeCapture();
    capture.write("hel");
    capture.write("lo\n");
    capture.write("wor");
    capture.end(); // 冲刷残余半行
    expect(emitted.length).toBe(2);
    expect(emitted[0]?.line).toBe("hello");
    expect(emitted[1]?.line).toBe("wor");
  });
});
