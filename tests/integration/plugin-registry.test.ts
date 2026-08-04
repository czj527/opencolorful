import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { instrument } from "../../src/observability/instrument.js";
import { LocalSourceAdapter } from "../../src/runtime/plugins/sources/local-source.js";
import { ZipSourceAdapter } from "../../src/runtime/plugins/sources/zip-source.js";
import { GitSourceAdapter } from "../../src/runtime/plugins/sources/git-source.js";
import { NpmSourceAdapter } from "../../src/runtime/plugins/sources/npm-source.js";
import { PluginInstaller } from "../../src/runtime/plugins/installer/plugin-installer.js";
import {
  PluginConflictError,
  PluginNotFoundError,
  PluginRegistry,
  PluginRollbackUnavailableError,
} from "../../src/runtime/plugins/registry/plugin-registry.js";
import { pluginDataDir, pluginVersionDir } from "../../src/runtime/plugins/paths.js";

const temporaryDirectories: string[] = [];
const openDatabases: Array<ReturnType<typeof openMetadataDatabase>> = [];

function createEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-plugin-registry-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  fs.mkdirSync(paths.pluginsCache, { recursive: true });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const producer: ProducerContext = {
    component: "agent-server",
    processType: "server",
    processId: "1",
    bootId: "boot",
    appVersion: "test",
    hostPlatform: process.platform,
  };
  const context = new ObservabilityContext({
    database,
    producer,
    logsRoot: path.join(paths.logs, "runtime", "server"),
    spoolRoot: path.join(paths.logs, "emergency"),
  });
  instrument.init(context);
  const adapters = [new LocalSourceAdapter(), new ZipSourceAdapter(), new GitSourceAdapter(), new NpmSourceAdapter()];
  const installer = new PluginInstaller({ paths, adapters, hostVersion: "1.0.0" });
  const store = new PluginRegistryStore(database);
  const registry = new PluginRegistry({ store, installer, paths, audit: context.audit });
  return { dir, paths, database, context, installer, store, registry };
}

function validManifest(
  pluginId: string,
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: pluginId,
    name: "Registry Fixture",
    version,
    description: "Phase 12 Registry 夹具",
    author: { name: "OpenColorful" },
    license: "MIT",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register", reason: "注册示例工具" }],
    contributions: { tool: [{ id: "registry.echo", name: "Echo", riskLevel: "low" }] },
    ...overrides,
  };
}

function writePluginDir(parent: string, manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(parent, "plugin-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
  return dir;
}

const USER_ACTOR = { actor: { kind: "user" as const, id: "test" } };

afterEach(() => {
  instrument.reset();
  vi.restoreAllMocks();
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function auditEventsFor(database: ReturnType<typeof openMetadataDatabase>, operationId: string) {
  return database
    .prepare(
      "SELECT event_name, decision, reason_code FROM audit_events WHERE operation_id = ? ORDER BY id ASC",
    )
    .all(operationId) as Array<{ event_name: string; decision: string; reason_code: string | null }>;
}

describe("Phase 12 Plugin Registry 安装（严格审计 + 事实来源）", () => {
  it("安装成功：active 切换、版本目录落盘、audit 生命周期与 activity 事件", async () => {
    const { paths, database, store, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const result = await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    expect(result.pluginId).toBe("example.registry");
    expect(result.version).toBe("1.0.0");

    const active = store.getActive("example.registry");
    expect(active?.version).toBe("1.0.0");
    expect(active?.active).toBe(true);
    expect(active?.status).toBe("installed");
    expect(active?.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.0.0"))).toBe(true);

    const installOp = store.listOperations("example.registry").find((op) => op.operation === "install");
    expect(installOp).toBeDefined();
    expect(installOp?.status).toBe("completed");
    const audits = auditEventsFor(database, installOp!.operationId);
    expect(audits.map((row) => row.event_name)).toEqual([
      "audit.plugin.install_started",
      "audit.plugin.install_completed",
    ]);
    expect(audits.every((row) => row.decision === "allowed")).toBe(true);

    const activityCount = database
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'plugin.installed'")
      .get() as { n: number };
    expect(activityCount.n).toBe(1);
  });

  it("重复安装同一版本被拒绝", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    await expect(registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR)).rejects.toThrow(/已安装/);
  });

  it("已有进行中操作（started 行）→ 冲突", async () => {
    const { paths, store, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    store.startOperation({ operationId: "op-manual", pluginId: "example.registry", operation: "install" });
    await expect(registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR)).rejects.toThrow(
      PluginConflictError,
    );
  });

  it("并发安装同一插件串行化：第一个成功，后续报已安装", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const first = registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    const second = registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    await expect(first).resolves.toMatchObject({ version: "1.0.0" });
    await expect(second).rejects.toThrow(/已安装/);
    expect(registry.listInstalled().length).toBe(1);
  });

  it("不同插件可并行安装", async () => {
    const { paths, registry } = createEnvironment();
    const dirA = writePluginDir(paths.pluginsCache, validManifest("example.aaa", "1.0.0"));
    const dirB = writePluginDir(paths.pluginsCache, validManifest("example.bbb", "1.0.0"));
    const [a, b] = await Promise.all([
      registry.install({ sourceType: "local", ref: dirA }, USER_ACTOR),
      registry.install({ sourceType: "local", ref: dirB }, USER_ACTOR),
    ]);
    expect(a.pluginId).toBe("example.aaa");
    expect(b.pluginId).toBe("example.bbb");
  });
});

describe("Phase 12 Plugin Registry 更新/回滚", () => {
  it("更新原子切换 active，旧版本保留用于回滚", async () => {
    const { paths, database, store, registry } = createEnvironment();
    const dirV1 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const dirV2 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.1.0"));
    await registry.install({ sourceType: "local", ref: dirV1 }, USER_ACTOR);
    await registry.enable("example.registry", USER_ACTOR);

    const result = await registry.update("example.registry", { sourceType: "local", ref: dirV2 }, USER_ACTOR);
    expect(result.version).toBe("1.1.0");
    expect(store.getActive("example.registry")?.version).toBe("1.1.0");
    const versions = store.listVersions("example.registry").map((record) => record.version);
    expect(versions).toEqual(["1.0.0", "1.1.0"]);
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.0.0"))).toBe(true);
    // 更新保留启用状态
    expect(store.getActive("example.registry")?.status).toBe("enabled");

    const updateOp = store.listOperations("example.registry").find((op) => op.operation === "update");
    expect(updateOp?.status).toBe("completed");
    const audits = auditEventsFor(database, updateOp!.operationId);
    expect(audits.map((row) => row.event_name)).toEqual([
      "audit.plugin.update_started",
      "audit.plugin.update_completed",
    ]);
    const updated = database
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'plugin.updated'")
      .get() as { n: number };
    expect(updated.n).toBe(1);
  });

  it("更新到更低版本被拒绝", async () => {
    const { paths, registry } = createEnvironment();
    const dirV1 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const dirV2 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.1.0"));
    await registry.install({ sourceType: "local", ref: dirV1 }, USER_ACTOR);
    await registry.update("example.registry", { sourceType: "local", ref: dirV2 }, USER_ACTOR);
    await expect(registry.update("example.registry", { sourceType: "local", ref: dirV1 }, USER_ACTOR)).rejects.toThrow(
      /更新版本必须高于/,
    );
    expect(registry.getActive("example.registry")?.version).toBe("1.1.0");
  });

  it("更新失败保留旧版本（预检拒绝不产生领域变更）", async () => {
    const { paths, store, registry } = createEnvironment();
    const dirV1 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const dirBad = writePluginDir(
      paths.pluginsCache,
      validManifest("example.registry", "1.1.0", {
        compatibility: { opencolorful: ">=999.0.0", pluginApi: 1 },
      }),
    );
    await registry.install({ sourceType: "local", ref: dirV1 }, USER_ACTOR);
    await expect(
      registry.update("example.registry", { sourceType: "local", ref: dirBad }, USER_ACTOR),
    ).rejects.toThrow(/插件不兼容/);
    // 预检（prepare）失败不产生操作行/领域变更，旧 active 保持不变
    expect(registry.getActive("example.registry")?.version).toBe("1.0.0");
    expect(store.listOperations("example.registry").some((op) => op.operation === "update")).toBe(false);
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.1.0"))).toBe(false);
    // 锁已释放：后续更新仍可正常进入（此处因版本不高于 active 被拒绝）
    await expect(registry.update("example.registry", { sourceType: "local", ref: dirV1 }, USER_ACTOR)).rejects.toThrow(
      /更新版本必须高于/,
    );
  });

  it("回滚切换到上一个版本并触发 rollback 生命周期", async () => {
    const { paths, database, store, registry } = createEnvironment();
    const dirV1 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    const dirV2 = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.1.0"));
    await registry.install({ sourceType: "local", ref: dirV1 }, USER_ACTOR);
    await registry.update("example.registry", { sourceType: "local", ref: dirV2 }, USER_ACTOR);

    const result = await registry.rollback("example.registry", USER_ACTOR);
    expect(result.version).toBe("1.0.0");
    expect(store.getActive("example.registry")?.version).toBe("1.0.0");

    const rollbackOp = store.listOperations("example.registry").find((op) => op.operation === "rollback");
    expect(rollbackOp?.status).toBe("completed");
    const audits = auditEventsFor(database, rollbackOp!.operationId);
    expect(audits.map((row) => row.event_name)).toEqual([
      "audit.plugin.rollback_started",
      "audit.plugin.rollback_completed",
    ]);
    const rollbackActivities = database
      .prepare(
        "SELECT event_name FROM activity_events WHERE event_name IN ('plugin.rollback.started', 'plugin.rollback.completed') ORDER BY event_name",
      )
      .all() as Array<{ event_name: string }>;
    expect(rollbackActivities.map((row) => row.event_name).sort()).toEqual([
      "plugin.rollback.completed",
      "plugin.rollback.started",
    ]);
  });

  it("无可回滚历史版本时报错", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    await expect(registry.rollback("example.registry", USER_ACTOR)).rejects.toThrow(PluginRollbackUnavailableError);
  });
});

describe("Phase 12 Plugin Registry 卸载/启停", () => {
  it("卸载：标记 removed、清 active、删版本目录、默认保留 data", async () => {
    const { paths, store, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    fs.mkdirSync(pluginDataDir(paths, "example.registry"), { recursive: true });
    fs.writeFileSync(path.join(pluginDataDir(paths, "example.registry"), "data.txt"), "x", "utf8");

    const result = await registry.uninstall("example.registry", USER_ACTOR);
    expect(result.removedVersions).toEqual(["1.0.0"]);
    expect(store.getActive("example.registry")).toBeUndefined();
    expect(store.getInstallation("example.registry", "1.0.0")?.status).toBe("removed");
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.0.0"))).toBe(false);
    expect(fs.existsSync(pluginDataDir(paths, "example.registry"))).toBe(true);
  });

  it("卸载并显式删除业务数据", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    fs.mkdirSync(pluginDataDir(paths, "example.registry"), { recursive: true });
    await registry.uninstall("example.registry", USER_ACTOR, { deleteData: true });
    expect(fs.existsSync(pluginDataDir(paths, "example.registry"))).toBe(false);
  });

  it("卸载后同版本可重装", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    await registry.uninstall("example.registry", USER_ACTOR);
    await expect(registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR)).resolves.toMatchObject({
      version: "1.0.0",
    });
  });

  it("卸载未安装的插件报错", async () => {
    const { registry } = createEnvironment();
    await expect(registry.uninstall("example.missing", USER_ACTOR)).rejects.toThrow(PluginNotFoundError);
  });

  it("enable/disable 状态机与 activity 事件", async () => {
    const { paths, database, store, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR);
    expect(store.getActive("example.registry")?.status).toBe("installed");

    await registry.enable("example.registry", USER_ACTOR);
    expect(store.getActive("example.registry")?.status).toBe("enabled");
    await registry.disable("example.registry", USER_ACTOR);
    expect(store.getActive("example.registry")?.status).toBe("disabled");
    // 幂等：重复 disable 不报错
    await registry.disable("example.registry", USER_ACTOR);
    expect(store.getActive("example.registry")?.status).toBe("disabled");

    const events = database
      .prepare(
        "SELECT event_name FROM activity_events WHERE event_name IN ('plugin.enabled', 'plugin.disabled') ORDER BY event_name",
      )
      .all() as Array<{ event_name: string }>;
    expect(events.map((row) => row.event_name).sort()).toEqual(["plugin.disabled", "plugin.enabled"]);
  });
});

describe("Phase 12 严格审计 fail-closed 与补偿", () => {
  it("Audit 不可用 → 安装被拒绝且不留任何状态", async () => {
    const { paths, installer, store } = createEnvironment();
    const closedDb = openMetadataDatabase(path.join(paths.home, "closed.db"));
    closedDb.close();
    const badAudit = new AuditRecorder({
      database: closedDb,
      producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot", appVersion: "test", hostPlatform: process.platform },
    });
    const badRegistry = new PluginRegistry({ store, installer, paths, audit: badAudit });
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await expect(badRegistry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR)).rejects.toThrow();
    expect(store.getInstallation("example.registry", "1.0.0")).toBeUndefined();
    expect(store.getActive("example.registry")).toBeUndefined();
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.0.0"))).toBe(false);
  });

  it("completed 审计写入失败 → 补偿恢复并写 failed 终态", async () => {
    const { dir, paths, database, context, store, registry } = createEnvironment();
    const audit = context.audit;
    const original = audit.appendStrict.bind(audit);
    const spy = vi.spyOn(audit, "appendStrict").mockImplementation((input) => {
      if (input.eventName === "audit.plugin.install_completed") {
        return { kind: "rejected", eventName: input.eventName, reason: "模拟终态审计失败" };
      }
      return original(input);
    });
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("example.registry", "1.0.0"));
    await expect(registry.install({ sourceType: "local", ref: pluginDir }, USER_ACTOR)).rejects.toThrow(/审计/);

    // 领域状态恢复：无安装行、无版本目录
    expect(store.getInstallation("example.registry", "1.0.0")).toBeUndefined();
    expect(store.getActive("example.registry")).toBeUndefined();
    expect(fs.existsSync(pluginVersionDir(paths, "example.registry", "1.0.0"))).toBe(false);
    // 操作标记补偿
    const ops = store.listOperations("example.registry");
    expect(ops.some((op) => op.operation === "install" && op.status === "compensated")).toBe(true);
    // 账本：started + failed 终态（reasonCode 稳定），无 completed
    const operationId = ops[0]!.operationId;
    const audits = auditEventsFor(database, operationId);
    expect(audits.map((row) => row.event_name).sort()).toEqual([
      "audit.plugin.install_failed",
      "audit.plugin.install_started",
    ]);
    const failed = audits.find((row) => row.event_name === "audit.plugin.install_failed");
    expect(failed?.decision).toBe("denied");
    expect(failed?.reason_code).toBe("install_failed");
    spy.mockRestore();
    void dir;
  });
});
