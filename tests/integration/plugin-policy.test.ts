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
import { EffectivePolicy, DefaultSessionRuntimePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import { ExecutionSnapshotService } from "../../src/runtime/plugins/grants/execution-snapshot.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// T3 权限交集与执行快照
// - effective = manifest ∩ grant ∩ binding ∩ session ∩ sandbox；
// - 跨 Agent 隔离：A 的绑定/授权不能被 B 使用；
// - Session/Runtime 策略层可注入；快照状态冻结实现 in-flight turn 不换实现。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

const producer: ProducerContext = {
  component: "t3-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t3-policy",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

function createContext(): {
  db: Database.Database;
  grantStore: PluginGrantStore;
  bindingStore: PluginBindingStore;
  grants: GrantService;
  bindings: BindingService;
  policy: EffectivePolicy;
  snapshots: ExecutionSnapshotService;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-policy-"));
  temporaryDirectories.push(dir);
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
  const snapshots = new ExecutionSnapshotService({ bindings: bindingStore, grants: grantStore });
  return { db, grantStore, bindingStore, grants, bindings, policy, snapshots };
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
const PLUGIN = "example.sdk";
const MANIFEST = [
  { capability: "tool.register" },
  { capability: "route.register" },
];

function grantAndBind(ctx: ReturnType<typeof createContext>, agentId = "a1", capabilities: CapabilityKind[] = ["tool.register", "route.register"]): void {
  for (const capability of capabilities) {
    ctx.grants.grant({ pluginId: PLUGIN, capability }, userActor);
  }
  ctx.bindings.bind({ agentId, pluginId: PLUGIN }, userActor);
}

describe("T3 EffectivePolicy：交集计算与拒绝层", () => {
  it("manifest 未声明的能力被拒绝（deniedBy=manifest）", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const resolution = ctx.policy.resolveCapability({
      pluginId: PLUGIN,
      agentId: "a1",
      capability: "network.connect",
      manifestPermissions: MANIFEST,
    });
    expect(resolution.allowed).toBe(false);
    expect(resolution.deniedBy).toBe("manifest");
    expect(resolution.evidence).toContain("manifest");
  });

  it("无平台授权被拒绝（deniedBy=grant）", () => {
    const ctx = createContext();
    const resolution = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "tool.register" });
    expect(resolution.allowed).toBe(false);
    expect(resolution.deniedBy).toBe("grant");
  });

  it("撤销授权立即拒绝（deniedBy=grant）", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    ctx.grants.revoke({ pluginId: PLUGIN, capability: "route.register" }, userActor);
    const resolution = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "route.register" });
    expect(resolution.allowed).toBe(false);
    expect(resolution.deniedBy).toBe("grant");
  });

  it("跨 Agent 隔离：A 授权并绑定后，B 使用同一插件被拒绝（deniedBy=binding）", () => {
    const ctx = createContext();
    grantAndBind(ctx, "a1");
    const forA = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "tool.register" });
    expect(forA.allowed).toBe(true);
    const forB = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a2", capability: "tool.register" });
    expect(forB.allowed).toBe(false);
    expect(forB.deniedBy).toBe("binding");
    expect(forB.reason).toMatch(/未绑定/);
  });

  it("授权 + 绑定全部通过 → allowed，证据链完整", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const resolution = ctx.policy.resolveCapability({
      pluginId: PLUGIN,
      agentId: "a1",
      capability: "tool.register",
      manifestPermissions: MANIFEST,
    });
    expect(resolution.allowed).toBe(true);
    expect(resolution.deniedBy).toBeNull();
    expect(resolution.evidence).toEqual(["manifest", "grant", "binding", "session"]);
  });

  it("Session/Runtime 策略层可注入拒绝（deniedBy=session）", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const denying = new DefaultSessionRuntimePolicy();
    const policy = new EffectivePolicy({
      grants: ctx.grantStore,
      bindings: ctx.bindingStore,
      sessionPolicy: {
        ...denying,
        resolve: (input) =>
          input.capability === "tool.register"
            ? { allowed: false, reason: "会话级禁止工具注册" }
            : null,
      },
    });
    const denied = policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "tool.register" });
    expect(denied.allowed).toBe(false);
    expect(denied.deniedBy).toBe("session");
    const allowed = policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "route.register" });
    expect(allowed.allowed).toBe(true);
  });

  it("sandbox 策略层可注入拒绝（deniedBy=sandbox）", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const policy = new EffectivePolicy({
      grants: ctx.grantStore,
      bindings: ctx.bindingStore,
      sandboxCheck: (input) =>
        input.capability === "filesystem.write"
          ? { allowed: false, reason: "沙箱禁止写入" }
          : null,
    });
    ctx.grants.grant({ pluginId: PLUGIN, capability: "filesystem.write" }, userActor);
    const denied = policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "filesystem.write" });
    expect(denied.allowed).toBe(false);
    expect(denied.deniedBy).toBe("sandbox");
  });

  it("绑定引用的 grantRevision 超前当前授权 → fail-closed（deniedBy=binding）", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    // 手工写入一个引用超前授权的绑定（模拟授权回滚/手动修改）
    const binding = ctx.bindingStore.get("a1", PLUGIN);
    if (binding === null) throw new Error("绑定不应为空");
    ctx.bindingStore.upsert({
      agentId: "a1",
      pluginId: PLUGIN,
      contributions: binding.contributions,
      grantRevision: 99,
      enabled: true,
      revision: binding.revision + 1,
      updatedAt: binding.updatedAt,
    });
    const resolution = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "tool.register" });
    expect(resolution.allowed).toBe(false);
    expect(resolution.deniedBy).toBe("binding");
  });
});

describe("T3 ExecutionSnapshot：不可变快照与下一 turn 生效", () => {
  it("未绑定或未授权时拒绝创建快照", () => {
    const ctx = createContext();
    expect(() =>
      ctx.snapshots.create({ pluginId: PLUGIN, pluginVersion: "1.0.0", runtimeKind: "bundle", runtimeInstanceId: "ri-1", agentId: "a1" }),
    ).toThrow(/未绑定/);

    ctx.grants.grant({ pluginId: PLUGIN, capability: "tool.register" }, userActor);
    expect(() =>
      ctx.snapshots.create({ pluginId: PLUGIN, pluginVersion: "1.0.0", runtimeKind: "bundle", runtimeInstanceId: "ri-1", agentId: "a1" }),
    ).toThrow(/未绑定/);

    ctx.bindings.bind({ agentId: "a1", pluginId: PLUGIN }, userActor);
    const created = ctx.snapshots.create({ pluginId: PLUGIN, pluginVersion: "1.0.0", runtimeKind: "bundle", runtimeInstanceId: "ri-1", agentId: "a1" });
    expect(created.snapshot.grantRevision).toBeGreaterThanOrEqual(1);
  });

  it("快照不可变：冻结、schema 合法、记录版本与 revision", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const { snapshot, state } = ctx.snapshots.create({
      pluginId: PLUGIN,
      pluginVersion: "1.2.3",
      runtimeKind: "node-process",
      runtimeInstanceId: "ri-42",
      agentId: "a1",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.contributions)).toBe(true);
    expect(Object.isFrozen(state.grants)).toBe(true);
    expect(snapshot.pluginId).toBe(PLUGIN);
    expect(snapshot.pluginVersion).toBe("1.2.3");
    expect(snapshot.runtimeKind).toBe("node-process");
    expect(snapshot.runtimeInstanceId).toBe("ri-42");
    expect(snapshot.grantRevision).toBe(ctx.grantStore.maxRevision(PLUGIN));
    expect(snapshot.bindingRevision).toBe(1);
    expect(ctx.snapshots.validate(snapshot).ok).toBe(true);
    expect(ctx.snapshots.validate({ ...snapshot, version: 99 }).ok).toBe(false);
  });

  it("同一 turn 内不换实现：撤销授权后快照状态仍放行，live 解析拒绝", () => {
    const ctx = createContext();
    grantAndBind(ctx);
    const { snapshot, state } = ctx.snapshots.create({
      pluginId: PLUGIN,
      pluginVersion: "1.0.0",
      runtimeKind: "bundle",
      runtimeInstanceId: "ri-1",
      agentId: "a1",
    });
    // turn 进行中：平台撤销授权（下一 turn 才生效）
    ctx.grants.revoke({ pluginId: PLUGIN, capability: "tool.register" }, userActor);
    // in-flight turn 用快照冻结状态 → 仍允许
    const inFlight = ctx.policy.resolveCapability({
      pluginId: PLUGIN,
      agentId: "a1",
      capability: "tool.register",
      state,
    });
    expect(inFlight.allowed).toBe(true);
    // 下一 turn 重新解析（live）→ 拒绝
    const nextTurn = ctx.policy.resolveCapability({ pluginId: PLUGIN, agentId: "a1", capability: "tool.register" });
    expect(nextTurn.allowed).toBe(false);
    expect(snapshot.grantRevision).toBeLessThan(ctx.grantStore.maxRevision(PLUGIN));
  });
});
