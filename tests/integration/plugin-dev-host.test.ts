import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindAgent,
  cleanupT5,
  createT5Env,
  producer,
  queryActivity,
  type T5Env,
} from "./plugin-t5-helper.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { PluginDevHost } from "../../src/runtime/plugins/dev/dev-host.js";
import { PluginDevInvokeService } from "../../src/runtime/plugins/dev/dev-invoke.js";
import { InMemorySecretStore } from "../../src/runtime/plugins/contributions/secret-contribution.js";
import { BundleRuntime } from "../../src/runtime/plugins/runtimes/bundle-runtime.js";
import { PLUGIN_ID_PATTERN } from "../../src/contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// T9 Dev Host 全链路（plans/phase-12.md §15 / §19.2）
// dev install → invoke → reload（devRunId 隔离）→ scenario →
// enable/disable → uninstall；destructive 审批；dev 目录隔离。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.dev-echo";
const AGENT = "agent-dev";
const USER_ACTOR = { kind: "user" as const, id: "user-dev" };

interface DevEnv {
  env: T5Env;
  host: PluginDevHost;
  invoke: PluginDevInvokeService;
  sourceDir: string;
}

const activeEnvs: DevEnv[] = [];

afterEach(() => {
  activeEnvs.splice(0);
  cleanupT5();
});

function setupDevEnv(manifestOverrides: Record<string, unknown> = {}): DevEnv {
  const env = createT5Env();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dev-src-"));
  const manifest = {
    manifestVersion: 1,
    id: PLUGIN,
    name: "Dev Echo",
    version: "1.0.0",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register" }],
    contributions: {
      tool: [{ id: "echo", name: "Echo", riskLevel: "low" }],
      page: [{ id: "settings-page", name: "Settings", entry: "ui/settings.html" }],
    },
    dev: { sourceDir: "." },
    ...manifestOverrides,
  };
  fs.mkdirSync(path.join(sourceDir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(sourceDir, "ui", "settings.html"), "<h1>settings</h1>", "utf8");

  const host = new PluginDevHost({
    paths: env.paths,
    store: env.store,
    audit: new AuditRecorder({ database: env.db, producer }),
    broker: env.broker,
    policy: env.policy,
    grants: env.grants,
    configStore: env.configStore,
    secretStore: new InMemorySecretStore(),
    hostVersion: "1.0.0",
    queryActivityEvents: (pluginId) =>
      env.db
        .prepare(
          "SELECT recorded_at, event_name, status, payload_json FROM activity_events WHERE plugin_id = ? ORDER BY id DESC LIMIT 50",
        )
        .all(pluginId) as Array<{ recorded_at: string; event_name: string; status: string | null; payload_json: string }>,
  });
  host.init();
  const invoke = new PluginDevInvokeService({ host });
  const devEnv: DevEnv = { env, host, invoke, sourceDir };
  activeEnvs.push(devEnv);
  return devEnv;
}

/** 绑定 Agent 并注册 echo handler（bundle 声明式 handler 在 dev RuntimeHost 上注册）。 */
function prepareEcho(devEnv: DevEnv, pluginId = PLUGIN): void {
  bindAgent(devEnv.env, AGENT, pluginId);
  const runtime = devEnv.host.getDevRuntimeHost().getInstance(pluginId)?.runtime as BundleRuntime;
  runtime.registerHandler("echo", (params) => {
    const text = typeof params === "object" && params !== null ? String((params as { text?: unknown }).text ?? "") : "";
    return { echoed: text };
  });
}

describe("PluginDevHost install / state / 目录隔离", () => {
  it("dev install 生成 devRunId，写入独立 dev 目录，不写正式插件目录", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    expect(state.pluginId).toBe(PLUGIN);
    expect(state.devRunId).toMatch(/^dev-/);
    expect(state.status).toBe("enabled");
    expect(state.surfaces).toContain("settings-page");

    // dev 运行时副本在 plugins-dev/<id>，不在 plugins/installed
    expect(fs.existsSync(path.join(devEnv.env.paths.pluginsDev, PLUGIN))).toBe(true);
    expect(fs.existsSync(path.join(devEnv.env.paths.pluginsInstalled, PLUGIN))).toBe(false);
    // 安装记录存在且 active
    const active = devEnv.env.store.getActive(PLUGIN);
    expect(active?.version).toBe("1.0.0");
    // 持久化 dev 状态文件
    expect(fs.existsSync(path.join(devEnv.env.paths.pluginsDev, PLUGIN, ".dev-state.json"))).toBe(true);
    // activity
    expect(queryActivity(devEnv.env.db, "plugin.dev.installed").length).toBe(1);
  });

  it("dev install 自动授予 manifest 请求的非高风险能力（tool.register）", async () => {
    const devEnv = setupDevEnv();
    await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    const grants = devEnv.env.grants.list(PLUGIN);
    expect(grants.some((grant) => grant.capability === "tool.register" && grant.decision === "allowed")).toBe(true);
    // 未请求的高风险能力不会被自动授予
    expect(grants.some((grant) => grant.capability === "filesystem.write")).toBe(false);
  });

  it("非法 manifest / 已安装冲突 拒绝安装", async () => {
    const devEnv = setupDevEnv();
    fs.writeFileSync(path.join(devEnv.sourceDir, "manifest.json"), '{ "bogus": true }', "utf8");
    await expect(devEnv.host.install({ sourceDir: devEnv.sourceDir })).rejects.toThrow(/manifest/);

    // 恢复合法 manifest 后安装，再次安装报已安装
    fs.writeFileSync(
      path.join(devEnv.sourceDir, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: PLUGIN,
        name: "Dev Echo",
        version: "1.0.0",
        compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
        trust: "restricted",
        runtime: { kind: "bundle" },
        permissions: [],
        contributions: {},
      }),
      "utf8",
    );
    await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    await expect(devEnv.host.install({ sourceDir: devEnv.sourceDir })).rejects.toThrow(/已安装/);
  });
});

describe("PluginDevHost invoke-tool 复用真实权限 + RuntimeHost 包装", () => {
  it("invoke-tool 返回工具结果并产生 plugin.execution.* 生命周期", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    prepareEcho(devEnv);

    const result = await devEnv.invoke.invokeTool({
      pluginId: PLUGIN,
      devRunId: state.devRunId,
      agentId: AGENT,
      toolName: "echo",
      args: { text: "hello" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echoed: "hello" });
    }
    const completed = queryActivity(devEnv.env.db, "plugin.execution.completed");
    expect(completed.length).toBeGreaterThan(0);
  });

  it("未绑定 Agent → 权限拒绝（不 bypass 真实权限）", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    // 不绑定 AGENT
    const runtime = devEnv.host.getDevRuntimeHost().getInstance(PLUGIN)?.runtime as BundleRuntime;
    runtime.registerHandler("echo", () => ({ echoed: "x" }));

    const result = await devEnv.invoke.invokeTool({
      pluginId: PLUGIN,
      devRunId: state.devRunId,
      agentId: AGENT,
      toolName: "echo",
      args: { text: "hello" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/拒绝|未绑定/);
    }
  });
});

describe("PluginDevHost devRunId 隔离", () => {
  it("reload 生成新 devRunId；旧 devRunId 不能操作新实例", async () => {
    const devEnv = setupDevEnv();
    const state1 = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    prepareEcho(devEnv);

    const state2 = await devEnv.host.reload(PLUGIN, state1.devRunId);
    expect(state2.devRunId).not.toBe(state1.devRunId);
    expect(queryActivity(devEnv.env.db, "plugin.dev.reloaded").length).toBe(1);

    // 新 devRunId 可调用
    prepareEcho(devEnv);
    const ok = await devEnv.invoke.invokeTool({
      pluginId: PLUGIN,
      devRunId: state2.devRunId,
      agentId: AGENT,
      toolName: "echo",
      args: { text: "hi" },
    });
    expect(ok.ok).toBe(true);

    // 旧 devRunId 被拒绝
    await expect(
      devEnv.invoke.invokeTool({
        pluginId: PLUGIN,
        devRunId: state1.devRunId,
        agentId: AGENT,
        toolName: "echo",
        args: { text: "hi" },
      }),
    ).rejects.toThrow(/devRunId 不匹配/);
    await expect(devEnv.host.reload(PLUGIN, state1.devRunId)).rejects.toThrow(/devRunId 不匹配/);
  });
});

describe("PluginDevHost enable / disable / reset / uninstall", () => {
  it("disable 停用运行实例与 contribution；enable 恢复", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    expect(devEnv.host.getDevRuntimeHost().getInstance(PLUGIN)).toBeDefined();

    const disabled = await devEnv.host.disable(PLUGIN, state.devRunId);
    expect(disabled.status).toBe("disabled");
    expect(devEnv.host.getDevRuntimeHost().getInstance(PLUGIN)).toBeUndefined();

    const enabled = await devEnv.host.enable(PLUGIN, state.devRunId);
    expect(enabled.status).toBe("enabled");
    expect(devEnv.host.getDevRuntimeHost().getInstance(PLUGIN)).toBeDefined();
  });

  it("uninstall 移除 dev 目录与安装记录；旧 devRunId 操作抛未安装", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    const result = await devEnv.host.uninstall(PLUGIN, state.devRunId);
    expect(result.removedVersions).toContain("1.0.0");
    expect(fs.existsSync(path.join(devEnv.env.paths.pluginsDev, PLUGIN))).toBe(false);
    expect(devEnv.env.store.getActive(PLUGIN)).toBeUndefined();
    await expect(devEnv.host.uninstall(PLUGIN, state.devRunId)).rejects.toThrow(/未安装/);
  });

  it("uninstall 撤销 dev 授权（plugin_grants 清空），reset 保留授权", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    // dev install 自动授予 manifest 请求的非高风险能力（tool.register）
    expect(devEnv.env.grantStore.list(PLUGIN).length).toBeGreaterThan(0);

    await devEnv.host.uninstall(PLUGIN, state.devRunId);
    expect(devEnv.env.grantStore.list(PLUGIN)).toHaveLength(0);

    // reset 是开发迭代语义：保留授权
    const devEnv2 = setupDevEnv();
    const state2 = await devEnv2.host.install({ sourceDir: devEnv2.sourceDir });
    await devEnv2.host.reset(PLUGIN, state2.devRunId);
    expect(devEnv2.env.grantStore.list(PLUGIN).length).toBeGreaterThan(0);
  });

  it("reset 清空 dev 槽", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    const result = await devEnv.host.reset(PLUGIN, state.devRunId);
    expect(result.status).toBe("reset");
    expect(devEnv.host.getSlot(PLUGIN)).toBeUndefined();
  });

  it("diagnostics 输出健康检查与最近事件", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    prepareEcho(devEnv);
    await devEnv.invoke.invokeTool({ pluginId: PLUGIN, devRunId: state.devRunId, agentId: AGENT, toolName: "echo", args: { text: "x" } });

    const diagnostics = await devEnv.host.diagnostics(PLUGIN);
    expect(diagnostics.pluginId).toBe(PLUGIN);
    expect(diagnostics.checks.some((check) => check.id === "source-dir" && check.ok)).toBe(true);
    expect(diagnostics.checks.some((check) => check.id === "runtime" && check.ok)).toBe(true);
    expect(diagnostics.recentEvents.some((event) => event.eventName === "plugin.execution.completed")).toBe(true);
  });
});

describe("PluginDevHost destructive 审批", () => {
  it("approveDestructive 记录审批；hasDestructiveApproval 命中当前 devRunId", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
    expect(devEnv.host.hasDestructiveApproval(PLUGIN, state.devRunId, "boom")).toBe(false);
    devEnv.host.approveDestructive(PLUGIN, state.devRunId, "boom", USER_ACTOR);
    expect(devEnv.host.hasDestructiveApproval(PLUGIN, state.devRunId, "boom")).toBe(true);
    // 未批准的场景仍为 false
    expect(devEnv.host.hasDestructiveApproval(PLUGIN, state.devRunId, "other")).toBe(false);
  });
});

describe("PluginDevHost init 恢复持久化 dev 槽", () => {
  it("重启（新实例）后 init 恢复 devRunId 上下文", async () => {
    const devEnv = setupDevEnv();
    const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });

    // 新 DevHost 实例共享同一 OPENCOLORFUL_HOME（同一个 env.paths）
    const host2 = new PluginDevHost({
      paths: devEnv.env.paths,
      store: devEnv.env.store,
      audit: new AuditRecorder({ database: devEnv.env.db, producer }),
      broker: devEnv.env.broker,
      policy: devEnv.env.policy,
      grants: devEnv.env.grants,
      configStore: devEnv.env.configStore,
      secretStore: new InMemorySecretStore(),
      hostVersion: "1.0.0",
    });
    host2.init();
    const restored = host2.getSlot(PLUGIN);
    expect(restored?.devRunId).toBe(state.devRunId);
    expect(restored?.sourceDir).toBe(devEnv.sourceDir);
  });
});

describe("PluginDevHost 插件 id 校验", () => {
  it("manifest id 必须匹配插件 id 模式", async () => {
    expect(new RegExp(PLUGIN_ID_PATTERN).test("example.dev-echo")).toBe(true);
    const devEnv = setupDevEnv();
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dev-bad-"));
    fs.writeFileSync(
      path.join(sourceDir, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "Bad ID",
        name: "Bad",
        version: "1.0.0",
        compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
        trust: "restricted",
        runtime: { kind: "bundle" },
        permissions: [],
        contributions: {},
      }),
      "utf8",
    );
    await expect(devEnv.host.install({ sourceDir })).rejects.toThrow(/manifest/);
  });
});
