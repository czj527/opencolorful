import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import type { RuntimePaths } from "../../src/config/paths.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { PluginInstaller } from "../../src/runtime/plugins/installer/plugin-installer.js";
import { PluginRegistry } from "../../src/runtime/plugins/registry/plugin-registry.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import { PluginConfigStore } from "../../src/storage/plugin-config-store.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import { GrantService } from "../../src/runtime/plugins/grants/grant-service.js";
import { BindingService } from "../../src/runtime/plugins/grants/binding-service.js";
import { HostBroker } from "../../src/runtime/plugins/grants/host-broker.js";
import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { RuntimeHost } from "../../src/runtime/plugins/runtimes/runtime-host.js";
import { BundleRuntime } from "../../src/runtime/plugins/runtimes/bundle-runtime.js";
import { PluginHostApi } from "../../src/runtime/plugins/contributions/host-api.js";
import { InMemorySecretStore } from "../../src/runtime/plugins/contributions/secret-contribution.js";
import { pluginVersionDir } from "../../src/runtime/plugins/paths.js";
import type { PluginRuntime, RuntimeFactory, RuntimeInvokeInput, RuntimeInvokeResult, RuntimeStatus } from "../../src/runtime/plugins/runtimes/runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// T5 测试环境：临时 OPENCOLORFUL_HOME + openMetadataDatabase +
// 完整插件运行时栈（registry/grants/bindings/broker/runtimeHost/hostApi）。
// 每个用例独立 temp dir，afterEach 统一关库删目录。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

export const producer: ProducerContext = {
  component: "t5-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t5",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

export interface T5Env {
  db: Database.Database;
  paths: RuntimePaths;
  dir: string;
  store: PluginRegistryStore;
  registry: PluginRegistry;
  grantStore: PluginGrantStore;
  bindingStore: PluginBindingStore;
  policy: EffectivePolicy;
  grants: GrantService;
  bindings: BindingService;
  broker: HostBroker;
  carriers: CarrierRegistry;
  runtimeHost: RuntimeHost;
  configStore: PluginConfigStore;
  hostApi: PluginHostApi;
}

export interface InstallPluginOptions {
  pluginId: string;
  version?: string;
  status?: "installed" | "enabled" | "disabled";
  contributions?: Record<string, unknown[]>;
  permissions?: ReadonlyArray<{ capability: string; reason?: string }>;
  trust?: "restricted" | "full-access";
  runtime?: Record<string, unknown>;
  /** 额外覆盖 manifest 顶层字段（如 manifest.config） */
  manifestExtras?: Record<string, unknown>;
}

export function createT5Env(options: { runtimeFactory?: RuntimeFactory } = {}): T5Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t5-"));
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

  const store = new PluginRegistryStore(db);
  const installer = new PluginInstaller({ paths, adapters: [], hostVersion: "1.0.0" });
  const registry = new PluginRegistry({ store, installer, paths, audit: context.audit });
  const grantStore = new PluginGrantStore(db);
  const bindingStore = new PluginBindingStore(db);
  const policy = new EffectivePolicy({ grants: grantStore, bindings: bindingStore });
  const grants = new GrantService({ store: grantStore, audit: context.audit });
  const bindings = new BindingService({ store: bindingStore, grants: grantStore, audit: context.audit });
  const broker = new HostBroker({ policy });
  const carriers = new CarrierRegistry();
  const runtimeHost = new RuntimeHost({ paths, registry, broker, carriers, ...(options.runtimeFactory !== undefined ? { runtimeFactory: options.runtimeFactory } : {}) });
  const configStore = new PluginConfigStore(db);
  const hostApi = new PluginHostApi({
    paths,
    registry,
    runtimeHost,
    broker,
    policy,
    configStore,
    secretStore: new InMemorySecretStore(),
    audit: context.audit,
  });
  hostApi.registerHostBrokerApis();

  return {
    db,
    paths,
    dir,
    store,
    registry,
    grantStore,
    bindingStore,
    policy,
    grants,
    bindings,
    broker,
    carriers,
    runtimeHost,
    configStore,
    hostApi,
  };
}

/** 写入不可变版本目录 + manifest，并保存安装记录（绕过安装器，聚焦 contribution）。 */
export function installPlugin(env: T5Env, options: InstallPluginOptions): void {
  const pluginId = options.pluginId;
  const version = options.version ?? "1.0.0";
  const versionDir = pluginVersionDir(env.paths, pluginId, version);
  fs.mkdirSync(versionDir, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: pluginId,
    name: `${pluginId} name`,
    version,
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: options.trust ?? "restricted",
    runtime: options.runtime ?? { kind: "bundle" },
    permissions: options.permissions ?? [],
    contributions: options.contributions ?? {},
    ...(options.manifestExtras ?? {}),
  };
  fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  env.store.saveInstallation({
    pluginId,
    version,
    active: true,
    status: options.status ?? "enabled",
    sourceType: "local",
    sourceRef: "file://t5-fixture",
    sourceVersion: null,
    artifactSha256: "sha256-t5",
    artifactSize: 1,
    provenance: {},
    manifest,
    installedAt: new Date().toISOString(),
  });
}

/** 以用户 actor 授予插件能力（高风险能力由用户确认路径放行）。 */
export function grantCapabilities(env: T5Env, pluginId: string, capabilities: readonly string[]): void {
  const userActor = { actor: { kind: "user" as const, id: "user-t5" } };
  for (const capability of capabilities) {
    env.grants.grant({ pluginId, capability: capability as Parameters<GrantService["grant"]>[0]["capability"] }, userActor);
  }
}

/** 绑定插件到 Agent（允许全部 contributions）。 */
export function bindAgent(env: T5Env, agentId: string, pluginId: string, contributions?: readonly string[]): void {
  env.bindings.bind(
    { agentId, pluginId, ...(contributions !== undefined ? { contributions } : {}) },
    { actor: { kind: "user", id: "user-t5" } },
  );
}

/** 查询 activity 事件（按 eventName，升序）。 */
export function queryActivity(db: Database.Database, eventName: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT event_name, status, operation_id, payload_json, owner_agent_id FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<Record<string, unknown>>;
}

/** 查询 audit 事件（按 eventName 前缀）。 */
export function queryAudit(db: Database.Database, prefix: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT event_name, operation_id, payload_json FROM audit_events WHERE event_name LIKE ? ORDER BY id ASC")
    .all(`${prefix}%`) as Array<Record<string, unknown>>;
}

/** 取得 bundle runtime 实例并注册声明式 handler（工具/路由/命令 handler 均走 BundleRuntime）。 */
export function bundleRuntimeOf(env: T5Env, pluginId: string): BundleRuntime {
  const instance = env.runtimeHost.getInstance(pluginId);
  if (instance === undefined) {
    throw new Error(`插件 ${pluginId} 没有运行实例`);
  }
  return instance.runtime as BundleRuntime;
}

export function cleanupT5(): void {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭则忽略
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/**
 * 测试用 abort-aware Bundle Runtime：invoke 返回的 handler promise 随
 * AbortSignal 终止（用于验证后台任务超时/terminateAll 的取消语义）。
 */
export class AbortAwareRuntime implements PluginRuntime {
  readonly kind = "bundle" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly handlers = new Map<string, (params: unknown, signal: AbortSignal) => Promise<unknown>>();

  constructor(options: { pluginId: string; version: string; runtimeInstanceId: string }) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
  }

  registerHandler(method: string, handler: (params: unknown, signal: AbortSignal) => Promise<unknown>): void {
    this.handlers.set(method, handler);
  }

  async start(): Promise<void> {
    this.state = "running";
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }

  async invoke(input: RuntimeInvokeInput): Promise<RuntimeInvokeResult> {
    if (this.state !== "running") {
      return { ok: false, code: "not-running", message: "未运行" };
    }
    const handler = this.handlers.get(input.method);
    if (handler === undefined) {
      return { ok: false, code: "method-not-found", message: "未注册方法" };
    }
    const signal = input.signal ?? new AbortController().signal;
    try {
      const value = await handler(input.params, signal);
      return { ok: true, result: value };
    } catch (error) {
      if (signal.aborted === true) {
        return { ok: false, code: "cancelled", message: "signal aborted" };
      }
      return { ok: false, code: "handler-error", message: error instanceof Error ? error.message : "handler error" };
    }
  }

  cancel(): void {
    // no-op
  }

  isHealthy(): boolean {
    return this.state === "running";
  }
}

/** 挂起直到 signal abort 的 handler 工厂（用于超时/终止测试）。 */
export function hangUntilAbort(value?: unknown): (params: unknown, signal: AbortSignal) => Promise<unknown> {
  return (_params, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void value;
    });
}
