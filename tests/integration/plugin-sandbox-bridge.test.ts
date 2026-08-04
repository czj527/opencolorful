import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import type { CapabilityKind } from "../../src/contracts/plugin-protocol.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import { GrantService } from "../../src/runtime/plugins/grants/grant-service.js";
import { BindingService } from "../../src/runtime/plugins/grants/binding-service.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import { SandboxBridge } from "../../src/runtime/plugins/grants/sandbox-bridge.js";
import { HostBroker } from "../../src/runtime/plugins/grants/host-broker.js";
import { PathGuard } from "../../src/sandbox/path-guard.js";
import type { PathGuardPolicy } from "../../src/contracts/sandbox.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// T3 沙箱桥接与 Host capability broker
// - 插件文件/网络/进程/Secret 操作走平台沙箱策略（能力交集 + PathGuard）；
// - denied 场景记录 plugin.sandbox.denied（不含路径/命令原文）；
// - Host broker 只暴露白名单 API；伪造/缺失身份、伪造权威字段、
//   未授权能力一律拒绝；不暴露 Store/spool/Audit 写入口。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

const producer: ProducerContext = {
  component: "t3-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t3-sandbox",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

const PLUGIN = "example.sandbox";

interface Ctx {
  db: Database.Database;
  grantStore: PluginGrantStore;
  bindingStore: PluginBindingStore;
  grants: GrantService;
  bindings: BindingService;
  policy: EffectivePolicy;
  bridge: SandboxBridge;
  broker: HostBroker;
  workspaceDir: string;
  readOnlyDir: string;
  blockedDir: string;
}

function createContext(withPathGuard: boolean): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-sandbox-"));
  temporaryDirectories.push(dir);
  const workspaceDir = path.join(dir, "workspace");
  const readOnlyDir = path.join(dir, "readonly");
  const blockedDir = path.join(dir, "blocked");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(readOnlyDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "file.txt"), "hello");
  fs.writeFileSync(path.join(readOnlyDir, "config.json"), "{}");
  fs.writeFileSync(path.join(blockedDir, "secret.txt"), "top-secret");

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(dir, "logs"),
    spoolRoot: path.join(dir, "spool"),
  });
  instrument.init(context);

  const grantStore = new PluginGrantStore(db);
  const bindingStore = new PluginBindingStore(db);
  const grants = new GrantService({ store: grantStore, audit: context.audit });
  const bindings = new BindingService({ store: bindingStore, grants: grantStore, audit: context.audit });
  const policy = new EffectivePolicy({ grants: grantStore, bindings: bindingStore });
  const pathGuard = withPathGuard ? makePathGuard({ workspaceDir, readOnlyDir, blockedDir }) : null;
  const bridge = new SandboxBridge({ policy, pathGuard });
  const broker = new HostBroker({ policy });
  return { db, grantStore, bindingStore, grants, bindings, policy, bridge, broker, workspaceDir, readOnlyDir, blockedDir };
}

function makePathGuard(ctx: Pick<Ctx, "workspaceDir" | "readOnlyDir" | "blockedDir">): PathGuard {
  const policy: PathGuardPolicy = {
    rules: [
      { path: ctx.blockedDir + path.sep, level: "BLOCKED", reason: "blocked subtree" },
      { path: ctx.readOnlyDir + path.sep, level: "READ_ONLY", reason: "read-only subtree" },
      { path: ctx.workspaceDir + path.sep, level: "FULL", reason: "workspace subtree" },
    ],
    defaultLevel: "BLOCKED",
    allowExternalReads: false,
  };
  return new PathGuard(policy);
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const userActor = { actor: { kind: "user" as const, id: "user-1" } };

function grantAndBind(ctx: Ctx, capabilities: CapabilityKind[], agentId = "a1"): void {
  for (const capability of capabilities) {
    ctx.grants.grant({ pluginId: PLUGIN, capability }, userActor);
  }
  ctx.bindings.bind({ agentId, pluginId: PLUGIN }, userActor);
}

function deniedEvents(db: Database.Database): Array<{ payload_json: string }> {
  return db.prepare(
    "SELECT payload_json FROM activity_events WHERE event_name = 'plugin.sandbox.denied' ORDER BY id ASC",
  ).all() as Array<{ payload_json: string }>;
}

describe("T3 SandboxBridge：文件操作走 PathGuard", () => {
  it("工作区内读取放行，工作区外拒绝并记录 plugin.sandbox.denied", () => {
    const ctx = createContext(true);
    grantAndBind(ctx, ["filesystem.read"]);
    const inside = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "read",
      path: path.join(ctx.workspaceDir, "file.txt"),
    });
    expect(inside.allowed).toBe(true);

    const outside = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "read",
      path: path.join(ctx.blockedDir, "secret.txt"),
    });
    expect(outside.allowed).toBe(false);
    if (!outside.allowed) expect(outside.deniedLayer).toBe("sandbox");

    const events = deniedEvents(ctx.db);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload_json) as { summaryCode: string; attributes: Record<string, unknown> };
    expect(payload.summaryCode).toBe("plugin_sandbox_denied");
    expect(payload.attributes).toMatchObject({ capability: "filesystem.read", operation: "read", deniedLayer: "sandbox" });
    // 路径按 Phase 11 脱敏：不落盘绝对路径原文
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(ctx.workspaceDir);
    expect(serialized).not.toContain(ctx.blockedDir);
    expect(serialized).not.toContain("secret.txt");
  });

  it("filesystem.write 未授权即被能力层拒绝；授权后在只读目录写入被 PathGuard 拒绝", () => {
    const ctx = createContext(true);
    // 未授权 write 能力
    const noCapability = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "write",
      path: path.join(ctx.workspaceDir, "new.txt"),
    });
    expect(noCapability.allowed).toBe(false);
    expect(noCapability.allowed === false && noCapability.deniedLayer).toBe("grant");

    grantAndBind(ctx, ["filesystem.write"]);
    const inReadOnly = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "write",
      path: path.join(ctx.readOnlyDir, "config.json"),
    });
    expect(inReadOnly.allowed).toBe(false);
    const inWorkspace = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "write",
      path: path.join(ctx.workspaceDir, "new.txt"),
    });
    expect(inWorkspace.allowed).toBe(true);
  });

  it("PathGuard 未注入（沙箱未配置）→ 文件操作 fail-closed 拒绝", () => {
    const ctx = createContext(false);
    grantAndBind(ctx, ["filesystem.read"]);
    const result = ctx.bridge.checkFileOperation({
      pluginId: PLUGIN,
      agentId: "a1",
      operation: "read",
      path: path.join(ctx.workspaceDir, "file.txt"),
    });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/沙箱未配置/);
  });
});

describe("T3 SandboxBridge：网络/进程/Secret", () => {
  it("network.connect 未授权拒绝，授权后放行", () => {
    const ctx = createContext(false);
    const denied = ctx.bridge.checkNetworkConnection({ pluginId: PLUGIN, agentId: "a1", target: "https://example.com" });
    expect(denied.allowed).toBe(false);
    grantAndBind(ctx, ["network.connect"]);
    const allowed = ctx.bridge.checkNetworkConnection({ pluginId: PLUGIN, agentId: "a1", target: "https://example.com" });
    expect(allowed.allowed).toBe(true);
  });

  it("process.spawn 未授权拒绝；授权后危险命令模式拒绝", () => {
    const ctx = createContext(false);
    expect(ctx.bridge.checkProcessSpawn({ pluginId: PLUGIN, agentId: "a1", command: "echo hi" }).allowed).toBe(false);
    grantAndBind(ctx, ["process.spawn"]);
    expect(ctx.bridge.checkProcessSpawn({ pluginId: PLUGIN, agentId: "a1", command: "echo hi" }).allowed).toBe(true);
    const dangerous = ctx.bridge.checkProcessSpawn({ pluginId: PLUGIN, agentId: "a1", command: "rm -rf /" });
    expect(dangerous.allowed).toBe(false);
    if (!dangerous.allowed) {
      expect(dangerous.deniedLayer).toBe("sandbox");
    }
    // 2 次 denied：未授权（grant 层）+ 危险命令模式（sandbox 层）
    const events = deniedEvents(ctx.db);
    expect(events).toHaveLength(2);
    const payload = JSON.parse(events[1]!.payload_json) as { attributes: Record<string, unknown> };
    expect(payload.attributes.pattern).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("rm -rf /");
  });

  it("secret.read-own 未授权拒绝，授权后放行", () => {
    const ctx = createContext(false);
    expect(ctx.bridge.checkSecretAccess({ pluginId: PLUGIN, agentId: "a1", secretName: "api-key" }).allowed).toBe(false);
    grantAndBind(ctx, ["secret.read-own"]);
    expect(ctx.bridge.checkSecretAccess({ pluginId: PLUGIN, agentId: "a1", secretName: "api-key" }).allowed).toBe(true);
  });
});

describe("T3 HostBroker：白名单 Host API 与身份校验", () => {
  it("平台签发实例可调用内置 host.ping；未注册实例被拒", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    const forged = ctx.broker.call({ identity: { ...identity, runtimeInstanceId: "ri-forged" }, apiName: "host.ping" });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("unauthorized-identity");

    ctx.broker.registerRuntimeInstance(identity);
    const ping = ctx.broker.call({ identity, apiName: "host.ping" });
    expect(ping.ok).toBe(true);
    if (ping.ok) expect(ping.value).toMatchObject({ pong: true, pluginId: PLUGIN, runtimeInstanceId: "ri-1" });
  });

  it("缺失/非法身份被拒；身份与实例不匹配被拒", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    ctx.broker.registerRuntimeInstance(identity);
    const missing = ctx.broker.call({ identity: { pluginId: "", runtimeInstanceId: "" }, apiName: "host.ping" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("unauthorized-identity");
    const mismatched = ctx.broker.call({ identity: { pluginId: "other.plugin", runtimeInstanceId: "ri-1" }, apiName: "host.ping" });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe("unauthorized-identity");
  });

  it("未知 Host API 拒绝；吊销实例后拒绝", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    ctx.broker.registerRuntimeInstance(identity);
    const unknown = ctx.broker.call({ identity, apiName: "not.an.api" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown-api");
    ctx.broker.invalidateRuntimeInstance("ri-1");
    const revoked = ctx.broker.call({ identity, apiName: "host.ping" });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("unauthorized-identity");
  });

  it("伪造平台权威字段（scope/trace/eventId）被拒", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    ctx.broker.registerRuntimeInstance(identity);
    const forged = ctx.broker.call({
      identity,
      apiName: "host.ping",
      args: { message: "hi", scope: { ownerAgentId: "a1" } },
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("forged-authority-fields");
    const forgedTrace = ctx.broker.call({
      identity,
      apiName: "host.ping",
      args: { trace: { traceId: "t", spanId: "s" } },
    });
    expect(forgedTrace.ok).toBe(false);
  });

  it("能力门控 API：未授权能力被拒，授权后放行", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    ctx.broker.registerRuntimeInstance(identity);
    ctx.broker.registerApi({
      name: "ui.toast",
      description: "宿主 toast 提示",
      requiredCapabilities: ["ui.surface"],
      handler: (_ctx, args) => ({ toast: true, ...(typeof args === "object" && args !== null ? args : {}) }),
    });
    const denied = ctx.broker.call({ identity, apiName: "ui.toast", agentId: "a1", args: { text: "hi" } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("capability-denied");

    grantAndBind(ctx, ["ui.surface"]);
    const allowed = ctx.broker.call({ identity, apiName: "ui.toast", agentId: "a1", args: { text: "hi" } });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value).toEqual({ toast: true, text: "hi" });
  });

  it("能力门控 API 缺少 Agent 上下文被拒；handler 异常被脱敏返回", () => {
    const ctx = createContext(false);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: "ri-1" };
    ctx.broker.registerRuntimeInstance(identity);
    grantAndBind(ctx, ["ui.surface"]);
    ctx.broker.registerApi({
      name: "host.demo",
      description: "测试 API",
      requiredCapabilities: ["ui.surface"],
      handler: () => {
        throw new Error("boom 内部错误");
      },
    });
    const noAgent = ctx.broker.call({ identity, apiName: "host.demo" });
    expect(noAgent.ok).toBe(false);
    if (!noAgent.ok) expect(noAgent.code).toBe("capability-denied");

    const handlerError = ctx.broker.call({ identity, apiName: "host.demo", agentId: "a1" });
    expect(handlerError.ok).toBe(false);
    if (!handlerError.ok) {
      expect(handlerError.code).toBe("handler-error");
      expect(handlerError.reason).toContain("boom");
    }
  });
});
