import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginConfigStore } from "../../src/storage/plugin-config-store.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { PluginBindingStore } from "../../src/storage/plugin-binding-store.js";
import {
  AuditRecorder,
  type AuditAcceptResult,
  type AuditRecorderDeps,
  type AuditRecordInput,
} from "../../src/observability/audit-recorder.js";
import { ContributionRegistry } from "../../src/runtime/plugins/contributions/contribution-registry.js";
import { ConfigService } from "../../src/runtime/plugins/contributions/config-contribution.js";
import { FileSecretStore } from "../../src/runtime/plugins/contributions/file-secret-store.js";
import { SecretService, InMemorySecretStore, SecretAccessError } from "../../src/runtime/plugins/contributions/secret-contribution.js";
import { runStrictAuditLifecycle, type StrictAuditLifecycleOptions } from "../../src/runtime/plugins/contributions/shared.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import {
  bindAgent,
  cleanupT5,
  createT5Env,
  grantCapabilities,
  installPlugin,
  producer,
  queryAudit,
  type T5Env,
} from "./plugin-t5-helper.js";

// ═══════════════════════════════════════════════════════════════
// T5 Config / Secret Contribution（plans/phase-12.md §8.7）
// - config 变更三阶段严格审计（started → 写入+completed / failed），fail-closed；
// - Secret 只读自身已授权（secret.read-own）；UI 不获得原文；
// - Secret 值不进入 Audit/payload。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.config";
const AGENT = "agent-a";
const USER_ACTOR = { kind: "user" as const, id: "user-t5" };

function installConfigPlugin(env: T5Env) {
  installPlugin(env, {
    pluginId: PLUGIN,
    version: "1.0.0",
    permissions: [{ capability: "secret.read-own" }],
    contributions: {
      config: [{ id: "main", name: "Main Config", schema: { type: "object", properties: { theme: { type: "string" } }, required: ["theme"], additionalProperties: false } }],
      secret: [{ id: "api-key", name: "API Key", secretName: "apiKey", purpose: "provider credential" }],
    },
  });
}

afterEach(() => {
  cleanupT5();
});

describe("ConfigService：读写与审计", () => {
  it("setConfig 写入并返回单调 revision；getConfig/listConfigs 可读", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const first = env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "light" }, actor: USER_ACTOR });
    const second = env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "dark" }, actor: USER_ACTOR });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(env.hostApi.config.getConfig(PLUGIN, AGENT)).toEqual({ theme: "dark" });
    expect(env.hostApi.config.listConfigs(PLUGIN)).toHaveLength(1);
  });

  it("全局（agentId=''）与 per-Agent 配置隔离", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: "", config: { theme: "global" }, actor: USER_ACTOR });
    env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "agent" }, actor: USER_ACTOR });
    expect(env.hostApi.config.getConfig(PLUGIN, "")).toEqual({ theme: "global" });
    expect(env.hostApi.config.getConfig(PLUGIN, AGENT)).toEqual({ theme: "agent" });
  });

  it("配置变更走 audit.plugin.config_change_* 三阶段，共享 operationId", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "light" }, actor: USER_ACTOR });
    const rows = queryAudit(env.db, "audit.plugin.config_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.config_change_started",
      "audit.plugin.config_change_completed",
    ]);
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
    const payload = JSON.parse(rows[1]?.payload_json as string) as { decision: string; action: string };
    expect(payload.action).toBe("plugin.config.change");
    expect(payload.decision).toBe("allowed");
  });

  it("配置不符合声明 Schema → 拒绝且无写入", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    expect(() =>
      env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: 42 }, actor: USER_ACTOR }),
    ).toThrow(/配置不符合插件声明的 Schema/);
    expect(env.hostApi.config.getConfig(PLUGIN, AGENT)).toBeNull();
  });

  it("removeConfig 删除指定 Agent 配置", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.config.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "light" }, actor: USER_ACTOR });
    env.hostApi.config.removeConfig({ pluginId: PLUGIN, agentId: AGENT, actor: USER_ACTOR });
    expect(env.hostApi.config.getConfig(PLUGIN, AGENT)).toBeNull();
  });

  it("audit 不可用 → 配置写入 fail-closed（不写入）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t5-config-closed-"));
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
    const liveDb = openMetadataDatabase(paths.database);
    const closedDb = openMetadataDatabase(path.join(dir, "audit-closed.db"));
    closedDb.close();
    const closedAudit = new AuditRecorder({ database: closedDb, producer: { component: "t5", processType: "server", processId: "1", bootId: "b", appVersion: "0", hostPlatform: process.platform } });
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        config: [{ id: "main", name: "Main", schema: { type: "object" } }],
      },
    });
    const service = new ConfigService({ registry, store: new PluginConfigStore(liveDb), audit: closedAudit });
    expect(() => service.setConfig({ pluginId: PLUGIN, agentId: AGENT, config: { theme: "x" }, actor: USER_ACTOR })).toThrow();
    expect(new PluginConfigStore(liveDb).get(PLUGIN, AGENT)).toBeNull();
    liveDb.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});

describe("SecretService：声明/读写与授权", () => {
  it("activate 声明 Secret；listSecretNames 只返回名称，不返回值", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.secrets.listSecretNames(PLUGIN)).toEqual(["apiKey"]);
    expect(env.hostApi.secrets.hasSecret(PLUGIN, "apiKey")).toBe(false);
  });

  it("setSecret 落库；readSecret 需 secret.read-own 授权，否则拒绝", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    grantCapabilities(env, PLUGIN, ["secret.read-own"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.secrets.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "super-secret", actor: USER_ACTOR });
    expect(env.hostApi.secrets.hasSecret(PLUGIN, "apiKey")).toBe(true);
    expect(env.hostApi.secrets.readSecret({ pluginId: PLUGIN, secretName: "apiKey", agentId: AGENT })).toBe("super-secret");
    // UI 侧（无 agent）只拿到名称列表
    expect(env.hostApi.secrets.listSecretNames(PLUGIN)).toEqual(["apiKey"]);
  });

  it("未授权 secret.read-own → readSecret 抛 SecretAccessError", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 绑定要求至少一项授权；不授 secret.read-own
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.secrets.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "v", actor: USER_ACTOR });
    expect(() => env.hostApi.secrets.readSecret({ pluginId: PLUGIN, secretName: "apiKey", agentId: AGENT })).toThrow(SecretAccessError);
  });

  it("未声明的 Secret 名称 → readSecret 拒绝（插件不能读未声明 Secret）", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    grantCapabilities(env, PLUGIN, ["secret.read-own"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    expect(() => env.hostApi.secrets.readSecret({ pluginId: PLUGIN, secretName: "other", agentId: AGENT })).toThrow(SecretAccessError);
  });

  it("Secret 变更走 audit.plugin.secret_change_* 三阶段，payload 不含 Secret 值", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.secrets.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "super-secret-value", actor: USER_ACTOR });
    const rows = queryAudit(env.db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_completed",
    ]);
    const joined = rows.map((row) => row.payload_json).join("");
    expect(joined).not.toContain("super-secret-value");
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
  });

  it("removeSecret 删除 Secret 并走审计终态", async () => {
    const env = createT5Env();
    installConfigPlugin(env);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.secrets.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "v", actor: USER_ACTOR });
    env.hostApi.secrets.removeSecret({ pluginId: PLUGIN, secretName: "apiKey", actor: USER_ACTOR });
    expect(env.hostApi.secrets.hasSecret(PLUGIN, "apiKey")).toBe(false);
    const rows = queryAudit(env.db, "audit.plugin.secret_change_");
    expect(rows.length).toBe(4); // set(started+completed) + remove(started+completed)
  });

  it("Secret 占位 store 按插件隔离（不同插件同名 Secret 互不读取）", () => {
    const store = new InMemorySecretStore();
    store.set("plugin.a", "key", "a-value");
    store.set("plugin.b", "key", "b-value");
    expect(store.get("plugin.a", "key")).toBe("a-value");
    expect(store.get("plugin.b", "key")).toBe("b-value");
    expect(store.listNames("plugin.a")).toEqual(["key"]);
  });

  it("audit 不可用 → Secret 写入 fail-closed（store 与磁盘均不写入）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t5-secret-closed-"));
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
    const liveDb = openMetadataDatabase(paths.database);
    const closedDb = openMetadataDatabase(path.join(dir, "audit-closed.db"));
    closedDb.close();
    const closedAudit = new AuditRecorder({ database: closedDb, producer });
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        secret: [{ id: "api-key", name: "API Key", secretName: "apiKey" }],
      },
    });
    const secretFilePath = path.join(dir, "plugin-secrets.json");
    const store = new FileSecretStore({ filePath: secretFilePath });
    const service = new SecretService({
      registry,
      policy: new EffectivePolicy({ grants: new PluginGrantStore(liveDb), bindings: new PluginBindingStore(liveDb) }),
      store,
      audit: closedAudit,
    });
    expect(() => service.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "v", actor: USER_ACTOR })).toThrow();
    expect(store.has(PLUGIN, "apiKey")).toBe(false);
    expect(fs.existsSync(secretFilePath)).toBe(false);
    liveDb.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-3：runStrictAuditLifecycle 审计失败补偿（shared.ts rollback）
// - completed 审计被拒（或 SQLite 事务提交失败）时，外部副作用（文件/
//   Secret）已生效，必须通过 rollback 恢复到变更前状态（§17.3 可验证补偿）；
// - write 自身抛错视为副作用未生效（写入方失败原子性：先持久化后更新
//   内存，如 FileSecretStore），不调用 rollback。
// ═══════════════════════════════════════════════════════════════

/** 注入"completed 审计被拒"的 Recorder：started 正常落库，completed 插入
 *  随 SQLite 事务回滚后返回 rejected，模拟"审计账本拒绝终态"。 */
class CompletedRejectingAudit extends AuditRecorder {
  constructor(deps: AuditRecorderDeps) {
    super(deps);
  }

  override appendStrict(input: AuditRecordInput): AuditAcceptResult {
    const result = super.appendStrict(input);
    if (input.eventName === "audit.plugin.secret_change_completed" && result.kind === "accepted") {
      return { kind: "rejected", eventName: input.eventName, reason: "模拟 completed 审计拒绝" };
    }
    return result;
  }
}

describe("runStrictAuditLifecycle：审计失败补偿（P0-3）", () => {
  let dir: string;
  let db: Database.Database;
  let audit: AuditRecorder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t5-audit-rollback-"));
    db = openMetadataDatabase(path.join(dir, "audit.db"));
    audit = new AuditRecorder({ database: db, producer });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function lifecycleOptions(overrides: { audit: AuditRecorder; operationId: string }): StrictAuditLifecycleOptions {
    return {
      audit: overrides.audit,
      trace: { traceId: "trace-p0-3", spanId: "span-p0-3", operationId: overrides.operationId },
      actor: USER_ACTOR,
      executor: { kind: "service", id: "plugin-secrets" },
      target: { kind: "plugin", id: PLUGIN },
      scope: { pluginId: PLUGIN },
      startEventName: "audit.plugin.secret_change_started",
      completedEventName: "audit.plugin.secret_change_completed",
      failedEventName: "audit.plugin.secret_change_failed",
      action: "secret.change",
      beforeRevision: "0",
      afterRevision: "1",
      changedFields: ["secretName"],
    };
  }

  it("completed 审计被拒：写入已生效时调用 rollback 补偿，账本为 started + failed", () => {
    const rejectingAudit = new CompletedRejectingAudit({ database: db, producer });
    let writeRan = false;
    let rollbackRan = false;
    const options: StrictAuditLifecycleOptions = {
      ...lifecycleOptions({ audit: rejectingAudit, operationId: "op-rollback-completed-rejected" }),
      rollback: () => {
        rollbackRan = true;
      },
    };

    expect(() => runStrictAuditLifecycle(options, () => { writeRan = true; })).toThrow(/审计记录被拒绝/);
    expect(writeRan).toBe(true);
    expect(rollbackRan).toBe(true);

    const rows = queryAudit(db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_failed",
    ]);
    // P1-4 可验证补偿：failed 终态记录补偿结果（写入已生效且 rollback 成功）
    const failedPayload = JSON.parse(rows[1]!.payload_json as string) as { compensation?: string; reasonCode?: string };
    expect(failedPayload.compensation).toBe("rolled-back");
    // P1 reasonCode 区分：写入已成功，失败发生在 completed 审计（而非领域写入）
    expect(failedPayload.reasonCode).toBe("completed_audit_failed");
  });

  it("write 自身抛错：视为副作用未生效，不调用 rollback", () => {
    let rollbackRan = false;
    const options: StrictAuditLifecycleOptions = {
      ...lifecycleOptions({ audit, operationId: "op-rollback-write-throws" }),
      rollback: () => {
        rollbackRan = true;
      },
    };

    expect(() => runStrictAuditLifecycle(options, () => { throw new Error("store 写入失败"); })).toThrow(/store 写入失败/);
    expect(rollbackRan).toBe(false);

    const rows = queryAudit(db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_failed",
    ]);
    // P1-4：写入未生效（副作用从未产生）→ 补偿不适用
    const failedPayload = JSON.parse(rows[1]!.payload_json as string) as { compensation?: string; reasonCode?: string };
    expect(failedPayload.compensation).toBe("not-applicable");
    // P1 reasonCode 区分：write 自身抛错 → 领域写入失败
    expect(failedPayload.reasonCode).toBe("domain_write_failed");
  });

  it("rollback 补偿自身抛错：failed 终态记录 rollback-failed（数据可能停留变更后状态）", () => {
    const rejectingAudit = new CompletedRejectingAudit({ database: db, producer });
    const options: StrictAuditLifecycleOptions = {
      ...lifecycleOptions({ audit: rejectingAudit, operationId: "op-rollback-rollback-throws" }),
      rollback: () => {
        throw new Error("补偿写盘失败");
      },
    };

    expect(() => runStrictAuditLifecycle(options, () => {})).toThrow(/审计记录被拒绝/);
    const rows = queryAudit(db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_failed",
    ]);
    const failedPayload = JSON.parse(rows[1]!.payload_json as string) as { compensation?: string; reasonCode?: string };
    expect(failedPayload.compensation).toBe("rollback-failed");
    // P1 reasonCode 区分：补偿自身失败 → compensation_failed
    expect(failedPayload.reasonCode).toBe("compensation_failed");
  });

  it("写入已生效但未提供 rollback 钩子：failed 终态如实记录 uncompensated", () => {
    const rejectingAudit = new CompletedRejectingAudit({ database: db, producer });
    const options: StrictAuditLifecycleOptions = lifecycleOptions({
      audit: rejectingAudit,
      operationId: "op-rollback-no-hook",
    });

    expect(() => runStrictAuditLifecycle(options, () => {})).toThrow(/审计记录被拒绝/);
    const rows = queryAudit(db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_failed",
    ]);
    const failedPayload = JSON.parse(rows[1]!.payload_json as string) as { compensation?: string; reasonCode?: string };
    expect(failedPayload.compensation).toBe("uncompensated");
    // P1 reasonCode 区分：写入已成功、无补偿钩子 → completed 审计失败
    expect(failedPayload.reasonCode).toBe("completed_audit_failed");
  });

  it("成功路径：写入与 completed 均落账，不调用 rollback", () => {
    let rollbackRan = false;
    const options: StrictAuditLifecycleOptions = {
      ...lifecycleOptions({ audit, operationId: "op-rollback-success" }),
      rollback: () => {
        rollbackRan = true;
      },
    };

    const result = runStrictAuditLifecycle(options, () => "ok");
    expect(result).toBe("ok");
    expect(rollbackRan).toBe(false);

    const rows = queryAudit(db, "audit.plugin.secret_change_");
    expect(rows.map((row) => row.event_name)).toEqual([
      "audit.plugin.secret_change_started",
      "audit.plugin.secret_change_completed",
    ]);
  });
});
