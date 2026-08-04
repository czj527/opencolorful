import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import { GrantService } from "../../src/runtime/plugins/grants/grant-service.js";
import { BindingService } from "../../src/runtime/plugins/grants/binding-service.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// T3 Agent 插件绑定（agent_plugin_bindings + binding-service）
// - 绑定只引用授权（grantRevision）不替代授权；绑定要求插件已授权；
// - revision 每次变更 +1（下一 turn 生效语义）；
// - 绑定变更严格审计三阶段；audit 失败 fail-closed。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

const producer: ProducerContext = {
  component: "t3-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t3-binding",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

function createContext(): {
  db: Database.Database;
  grantStore: PluginGrantStore;
  bindingStore: PluginBindingStore;
  grants: GrantService;
  bindings: BindingService;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-binding-"));
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
  return { db, grantStore, bindingStore, grants, bindings };
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

function setupPlugin(ctx: ReturnType<typeof createContext>, pluginId = "example.sdk"): void {
  ctx.grants.grant({ pluginId, capability: "tool.register" }, userActor);
  ctx.grants.grant({ pluginId, capability: "route.register" }, userActor);
}

describe("T3 BindingService：绑定引用授权，不替代授权", () => {
  it("插件未授权任何能力时绑定被拒绝", () => {
    const ctx = createContext();
    expect(() => ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor))
      .toThrow(/尚未授予任何能力/);
    expect(ctx.bindingStore.get("a1", "example.sdk")).toBeNull();
  });

  it("绑定成功后引用当前 grantRevision，revision 从 1 递增", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    const first = ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    expect(first.revision).toBe(1);
    expect(first.grantRevision).toBe(ctx.grantStore.maxRevision("example.sdk"));
    expect(first.contributions).toEqual([]);
    expect(first.enabled).toBe(true);

    const second = ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk", contributions: ["tool.list"] }, userActor);
    expect(second.revision).toBe(2);
    expect(second.contributions).toEqual(["tool.list"]);
    expect(second.grantRevision).toBe(first.grantRevision);

    expect(ctx.bindingStore.listByAgent("a1")).toHaveLength(1);
  });

  it("绑定支持 contribution 子集校验（重复/超限/非法 id 拒绝）", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    expect(() =>
      ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk", contributions: ["tool.a", "tool.a"] }, userActor),
    ).toThrow(/重复/);
    const tooMany = Array.from({ length: 513 }, (_v, i) => `tool.${i}`);
    expect(() =>
      ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk", contributions: tooMany }, userActor),
    ).toThrow(/超出上限/);
    expect(() =>
      ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk", contributions: [""] }, userActor),
    ).toThrow(/contribution id 不合法/);
  });
});

describe("T3 BindingService：unbind / setEnabled", () => {
  it("unbind 移除绑定并保留严格审计证据", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    ctx.bindings.unbind("a1", "example.sdk", userActor);
    expect(ctx.bindingStore.get("a1", "example.sdk")).toBeNull();
    expect(() => ctx.bindings.unbind("a1", "example.sdk", userActor)).toThrow(/绑定不存在/);

    const rows = ctx.db.prepare(
      "SELECT event_name, operation_id FROM audit_events WHERE event_name LIKE 'audit.plugin.agent_binding_change_%' ORDER BY id ASC",
    ).all() as Array<{ event_name: string; operation_id: string }>;
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.plugin.agent_binding_change_started",
      "audit.plugin.agent_binding_change_completed",
      "audit.plugin.agent_binding_change_started",
      "audit.plugin.agent_binding_change_completed",
    ]);
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
  });

  it("setEnabled 切换启用状态并递增 revision（下一 turn 生效）", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    const disabled = ctx.bindings.setEnabled("a1", "example.sdk", false, userActor);
    expect(disabled.enabled).toBe(false);
    expect(disabled.revision).toBe(2);
    const enabled = ctx.bindings.setEnabled("a1", "example.sdk", true, userActor);
    expect(enabled.enabled).toBe(true);
    expect(enabled.revision).toBe(3);
    expect(() => ctx.bindings.setEnabled("a2", "example.sdk", true, userActor)).toThrow(/绑定不存在/);
  });
});

describe("T3 BindingService：跨 Agent 隔离与 fail-closed", () => {
  it("绑定只归属指定 Agent，其他 Agent 不可见", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    expect(ctx.bindings.get("a1", "example.sdk")).not.toBeNull();
    expect(ctx.bindings.get("a2", "example.sdk")).toBeNull();
    expect(ctx.bindingStore.listByAgent("a2")).toHaveLength(0);
  });

  it("grant 变更后（revision +1）既有绑定仍有效，引用旧 grantRevision", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    const before = ctx.grantStore.maxRevision("example.sdk");
    const binding = ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    expect(binding.grantRevision).toBe(before);
    ctx.grants.grant({ pluginId: "example.sdk", capability: "ui.surface" }, userActor);
    expect(ctx.grantStore.maxRevision("example.sdk")).toBe(before + 1);
    expect(ctx.bindingStore.get("a1", "example.sdk")?.grantRevision).toBe(before);
  });
});

describe("T3 PluginBindingStore：removeByPlugin", () => {
  it("按插件移除全部绑定，不影响其他插件", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    ctx.grants.grant({ pluginId: "example.other", capability: "tool.register" }, userActor);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    ctx.bindings.bind({ agentId: "a2", pluginId: "example.sdk" }, userActor);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.other" }, userActor);

    ctx.bindingStore.removeByPlugin("example.sdk");

    expect(ctx.bindingStore.listByPlugin("example.sdk")).toHaveLength(0);
    expect(ctx.bindingStore.listByPlugin("example.other")).toHaveLength(1);
    expect(ctx.bindingStore.listByAgent("a1").map((b) => b.pluginId)).toEqual(["example.other"]);
  });

  it("对无绑定插件调用 removeByPlugin 是 no-op", () => {
    const ctx = createContext();
    setupPlugin(ctx);
    ctx.bindings.bind({ agentId: "a1", pluginId: "example.sdk" }, userActor);
    expect(() => ctx.bindingStore.removeByPlugin("example.ghost")).not.toThrow();
    expect(ctx.bindingStore.listByPlugin("example.sdk")).toHaveLength(1);
  });
});
