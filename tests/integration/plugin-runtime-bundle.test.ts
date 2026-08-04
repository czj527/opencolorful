import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { PluginRegistry } from "../../src/runtime/plugins/registry/plugin-registry.js";
import { PluginInstaller } from "../../src/runtime/plugins/installer/plugin-installer.js";
import { HostBroker } from "../../src/runtime/plugins/grants/host-broker.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { RuntimeHost } from "../../src/runtime/plugins/runtimes/runtime-host.js";
import { BundleRuntime } from "../../src/runtime/plugins/runtimes/bundle-runtime.js";

// ═══════════════════════════════════════════════════════════════
// T4 Bundle Runtime（plans/phase-12.md §9.1）
// - 无子进程：声明式 handler 由 Host 直接执行；
// - 仍走 RuntimeHost 统一的 permission + Trace + Activity 包装；
// - 不产生 plugin.process.* 事件。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

interface Env {
  db: Database.Database;
  registry: PluginRegistry;
  broker: HostBroker;
  carriers: CarrierRegistry;
  host: RuntimeHost;
  versionDir: string;
}

function createEnv(overrides: { manifestRuntime?: Record<string, unknown> } = {}): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-runtime-bundle-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  const producer: ProducerContext = {
    component: "runtime-host-test",
    processType: "server",
    processId: "1",
    bootId: "boot-bundle",
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
  const host = new RuntimeHost({ paths, registry, broker, carriers });

  // 版本目录 + manifest
  const versionDir = path.join(paths.pluginsInstalled, "example.bundle", "1.0.0");
  fs.mkdirSync(versionDir, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: "example.bundle",
    name: "Bundle Fixture",
    version: "1.0.0",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: overrides.manifestRuntime ?? { kind: "bundle" },
    permissions: [],
    contributions: {},
  };
  fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  store.saveInstallation({
    pluginId: "example.bundle",
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
  return { db, registry, broker, carriers, host, versionDir };
}

function queryActivity(db: Database.Database, eventName: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT event_name, status, operation_id, payload_json FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<Record<string, unknown>>;
}

afterEach(() => {
  instrument.reset();
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

describe("BundleRuntime + RuntimeHost", () => {
  it("start 后实例 running 且健康，不产生 plugin.process.* 事件", async () => {
    const { db, host } = createEnv();
    const instance = await host.start("example.bundle");
    expect(instance.status).toBe("running");
    expect(host.isHealthy("example.bundle")).toBe(true);
    expect(instance.kind).toBe("bundle");
    expect(instance.runtime).toBeInstanceOf(BundleRuntime);
    expect(queryActivity(db, "plugin.process.started")).toHaveLength(0);
  });

  it("invoke 走权限 + Trace 包装：声明式 handler 由 Host 直接执行", async () => {
    const { db, host } = createEnv();
    await host.start("example.bundle");
    const instance = host.getInstance("example.bundle");
    const runtime = instance?.runtime as BundleRuntime;
    runtime.registerHandler("declarative.echo", (params) => ({ echo: params, computedInHost: true }));
    const result = await host.invoke({
      pluginId: "example.bundle",
      contributionKind: "tool",
      contributionId: "declarative.echo",
      method: "declarative.echo",
      params: { value: 42 },
      agentId: "a1",
      sessionId: "s1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echo: { value: 42 }, computedInHost: true });
    }
    const started = queryActivity(db, "plugin.execution.started");
    const completed = queryActivity(db, "plugin.execution.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.operation_id).toBe(completed[0]?.operation_id);
    const payload = JSON.parse(completed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({
      contributionKind: "tool",
      id: "declarative.echo",
      pluginId: "example.bundle",
      version: "1.0.0",
      runtimeKind: "bundle",
      status: "completed",
    });
  });

  it("未注册方法 → method-not-found，并记录 failed 终态", async () => {
    const { db, host } = createEnv();
    await host.start("example.bundle");
    const result = await host.invoke({
      pluginId: "example.bundle",
      contributionKind: "tool",
      contributionId: "missing.tool",
      method: "missing.tool",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("method-not-found");
    }
    const failed = queryActivity(db, "plugin.execution.failed");
    expect(failed).toHaveLength(1);
  });

  it("未启动时 invoke → not-running", async () => {
    const { host } = createEnv();
    const result = await host.invoke({
      pluginId: "example.bundle",
      contributionKind: "tool",
      contributionId: "x",
      method: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-running");
    }
  });

  it("stop 后状态 stopped，重复 stop 幂等", async () => {
    const { host } = createEnv();
    await host.start("example.bundle");
    await host.stop("example.bundle", "plugin_disabled");
    expect(host.getInstance("example.bundle")).toBeUndefined();
    await expect(host.stop("example.bundle", "plugin_disabled")).resolves.toBeUndefined();
  });

  it("启动已运行实例幂等返回同一实例", async () => {
    const { host } = createEnv();
    const first = await host.start("example.bundle");
    const second = await host.start("example.bundle");
    expect(second.runtimeInstanceId).toBe(first.runtimeInstanceId);
  });

  it("禁止启动 disabled/未安装插件", async () => {
    const { host } = createEnv();
    await expect(host.start("example.missing")).rejects.toThrow(/未安装/);
  });
});
