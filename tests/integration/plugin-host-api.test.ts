import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AbortAwareRuntime,
  bindAgent,
  bundleRuntimeOf,
  cleanupT5,
  createT5Env,
  grantCapabilities,
  hangUntilAbort,
  installPlugin,
  queryActivity,
  type T5Env,
} from "./plugin-t5-helper.js";

// ═══════════════════════════════════════════════════════════════
// T5 Host API（plans/phase-12.md §8 / §19.2 / §21.2）
// - activate/deactivate 生命周期：登记 + Runtime 启动/停止，失败回滚；
// - Command / Provider / Surface / Background / Hook / Broker API 接线。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.host";
const AGENT = "agent-a";
const USER = { actor: { kind: "user" as const, id: "user-t5" } };

afterEach(() => {
  cleanupT5();
});

describe("PluginHostApi：activate / deactivate 生命周期", () => {
  it("activate 登记贡献并启动 Runtime；getInstance 可查", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "tool.register" }],
      contributions: { tool: [{ id: "echo", name: "Echo", riskLevel: "low" }] },
    });
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.contributions.isRegistered(PLUGIN, "echo")).toBe(true);
    expect(env.runtimeHost.getInstance(PLUGIN)).toBeDefined();
    expect(env.runtimeHost.isHealthy(PLUGIN)).toBe(true);
  });

  it("activate 跨 kind 重复 id → 激活失败且不残留（回滚）", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        tool: [{ id: "dup", name: "Tool" }],
        command: [{ id: "dup", name: "Command" }],
      },
    });
    await expect(env.hostApi.activate(PLUGIN)).rejects.toThrow(/contribution id 重复/);
    expect(env.hostApi.contributions.listPlugins()).toEqual([]);
    expect(env.runtimeHost.getInstance(PLUGIN)).toBeUndefined();
  });

  it("deactivate 注销贡献并停止 Runtime", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: { tool: [{ id: "echo", name: "Echo" }] },
    });
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.tools.listTools()).toHaveLength(1);
    await env.hostApi.deactivate(PLUGIN, "plugin_disabled");
    expect(env.hostApi.tools.listTools()).toHaveLength(0);
    expect(env.runtimeHost.getInstance(PLUGIN)).toBeUndefined();
  });

  it("disabled 状态插件不能激活", async () => {
    const env = createT5Env();
    installPlugin(env, { pluginId: PLUGIN, version: "1.0.0", status: "disabled", contributions: {} });
    await expect(env.hostApi.activate(PLUGIN)).rejects.toThrow(/无法激活/);
  });

  it("未安装插件不能激活", async () => {
    const env = createT5Env();
    await expect(env.hostApi.activate("example.missing")).rejects.toThrow(/未安装/);
  });
});

describe("CommandService", () => {
  it("invoke 经 RuntimeHost（contributionKind=command）并校验参数 Schema", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [],
      contributions: {
        command: [
          { id: "deploy", name: "Deploy", argumentsSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"], additionalProperties: false } },
        ],
      },
    });
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 绑定要求至少一项授权
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    bundleRuntimeOf(env, PLUGIN).registerHandler("deploy", (params) => ({ deployed: (params as { env: string }).env }));

    const ok = await env.hostApi.commands.invoke({ pluginId: PLUGIN, contributionId: "deploy", args: { env: "prod" }, agentId: AGENT });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.result).toEqual({ deployed: "prod" });
    }
    const completed = queryActivity(env.db, "plugin.execution.completed");
    const payload = JSON.parse(completed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({ contributionKind: "command", id: "deploy" });

    const bad = await env.hostApi.commands.invoke({ pluginId: PLUGIN, contributionId: "deploy", args: { env: 42 }, agentId: AGENT });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid-args");
    }
  });
});

describe("ProviderService", () => {
  it("invoke 经 RuntimeHost（contributionKind=provider）并携带 operation", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "provider.register" }],
      contributions: { provider: [{ id: "search", name: "Search", kind: "search" }] },
    });
    grantCapabilities(env, PLUGIN, ["provider.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    bundleRuntimeOf(env, PLUGIN).registerHandler("search", (params) => ({ results: (params as { operation: string }).operation }));

    const result = await env.hostApi.providers.invoke({ pluginId: PLUGIN, providerId: "search", operation: "search.execute", params: { q: "x" }, agentId: AGENT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ results: "search.execute" });
    }
    const completed = queryActivity(env.db, "plugin.execution.completed");
    const payload = JSON.parse(completed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({ contributionKind: "provider", id: "search" });
  });

  it("凭据 Secret 绑定接口声明（不读取其他 Provider 凭据）", async () => {
    const env = createT5Env();
    env.hostApi.providers.bindCredentialSecrets(PLUGIN, "search", ["searchApiKey"]);
    const binding = env.hostApi.providers.getCredentialBinding(PLUGIN, "search");
    expect(binding?.secretNames).toEqual(["searchApiKey"]);
    expect(env.hostApi.providers.getCredentialBinding("example.other", "search")).toBeUndefined();
  });
});

describe("BackgroundService", () => {
  function installBackgroundPlugin(env: T5Env, spec: Record<string, unknown> & { id: string; name: string }) {
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "background.run" }],
      contributions: { background: [spec] },
    });
  }

  it("run 成功并写入幂等键缓存（重复 idempotencyKey 不再执行）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 1, maxRetries: 0, timeoutMs: 5000 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    let calls = 0;
    runtime.registerHandler("worker", async () => {
      calls += 1;
      return { job: "done" };
    });

    const first = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", params: { a: 1 }, idempotencyKey: "k1", agentId: AGENT });
    expect(first.ok).toBe(true);
    const second = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", params: { a: 1 }, idempotencyKey: "k1", agentId: AGENT });
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("run 重试：首次失败，maxRetries 后成功", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 1, maxRetries: 2, timeoutMs: 5000 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    let calls = 0;
    runtime.registerHandler("worker", async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error("transient");
      }
      return { ok: true };
    });
    const result = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("run 重试耗尽 → failed（attempt 反映最终尝试）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 1, maxRetries: 1, timeoutMs: 5000 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("worker", async () => {
      throw new Error("always fails");
    });
    const result = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("failed");
      expect(result.attempt).toBe(2);
    }
  });

  it("run 超时 → timeout（timeoutMs 内未完成即终止）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 1, maxRetries: 0, timeoutMs: 100 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("worker", hangUntilAbort());
    const result = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
  });

  it("并发达到上限 → concurrency-limit", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 1, maxRetries: 0, timeoutMs: 5000 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("worker", hangUntilAbort());
    const first = env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    const second = await env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("concurrency-limit");
    }
    env.hostApi.background.terminateAll(PLUGIN, "plugin_disabled");
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    if (!firstResult.ok) {
      expect(firstResult.code).toBe("cancelled");
    }
  });

  it("terminateAll 终止 in-flight 后台任务（禁用/更新清理）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installBackgroundPlugin(env, { id: "worker", name: "Worker", maxConcurrency: 2, maxRetries: 0, timeoutMs: 60_000 });
    grantCapabilities(env, PLUGIN, ["background.run"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("worker", hangUntilAbort());
    const pending = env.hostApi.background.run({ pluginId: PLUGIN, contributionId: "worker", agentId: AGENT });
    env.hostApi.background.terminateAll(PLUGIN, "plugin_disabled");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
      expect(result.reasonCode).toBe("plugin_disabled");
    }
  });
});

describe("BackgroundService：Lifecycle Hook", () => {
  function installHookPlugin(env: T5Env, hookSpec: Record<string, unknown> & { id: string; name: string }) {
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "hook.register" }],
      contributions: { hook: [hookSpec] },
    });
  }

  it("before Hook（block）失败 → 阻止变更（blocked）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installHookPlugin(env, { id: "guard", name: "Guard", point: "message.before-send", behavior: "block" });
    grantCapabilities(env, PLUGIN, ["hook.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("guard", async () => {
      throw new Error("block this message");
    });
    const result = await env.hostApi.background.runHook({ point: "message.before-send", direction: "before", params: { text: "hi" }, agentId: AGENT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("block this message");
    }
  });

  it("after Hook 失败 → degraded 不回滚（ok 仍为 true）", async () => {
    const env = createT5Env({
      runtimeFactory: (ctx) => new AbortAwareRuntime(ctx),
    });
    installHookPlugin(env, { id: "audit-log", name: "Audit Log", point: "message.after-send", behavior: "observe" });
    grantCapabilities(env, PLUGIN, ["hook.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const runtime = env.runtimeHost.getInstance(PLUGIN)?.runtime as AbortAwareRuntime;
    runtime.registerHandler("audit-log", async () => {
      throw new Error("logging failed");
    });
    const result = await env.hostApi.background.runHook({ point: "message.after-send", direction: "after", params: {}, agentId: AGENT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.degraded).toBe(true);
      expect(result.results[0]?.ok).toBe(false);
    }
  });

  it("无绑定 Hook 的时点 → 直接放行", async () => {
    const env = createT5Env();
    const result = await env.hostApi.background.runHook({ point: "turn.before-start", direction: "before" });
    expect(result).toEqual({ ok: true, degraded: false, results: [] });
  });

  it("非冻结 Hook 时点 → 激活失败（fail-closed）", async () => {
    const env = createT5Env();
    installHookPlugin(env, { id: "bad", name: "Bad", point: "agent.arbitrary-hook", behavior: "block" });
    await expect(env.hostApi.activate(PLUGIN)).rejects.toThrow(/Hook 时点未在平台冻结清单/);
  });
});

describe("SurfaceService", () => {
  it("listSurfaces/getSurface 登记 Page/Widget/Chat Surface", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "ui.surface" }],
      contributions: {
        page: [{ id: "settings", name: "Settings Page", entry: "page/index.html", hostCapabilities: ["theme"] }],
        widget: [{ id: "status", name: "Status Widget", entry: "widget/index.js" }],
        "chat-surface": [{ id: "main", name: "Chat Panel", entry: "chat/index.html" }],
      },
    });
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.surfaces.listSurfaces()).toHaveLength(3);
    expect(env.hostApi.surfaces.listSurfaces("page")).toHaveLength(1);
    expect(env.hostApi.surfaces.getSurface(PLUGIN, "status")?.kind).toBe("widget");
  });

  it("authorizeSurface：未授予 ui.surface → 拒绝并记录 plugin.surface.capability_denied", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "ui.surface" }],
      contributions: { page: [{ id: "settings", name: "Settings" }] },
    });
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 绑定要求至少一项授权；不授 ui.surface
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const denied = env.hostApi.surfaces.authorizeSurface({ pluginId: PLUGIN, surfaceId: "settings", agentId: AGENT });
    expect(denied.ok).toBe(false);
    const events = queryActivity(env.db, "plugin.surface.capability_denied");
    expect(events).toHaveLength(1);

    grantCapabilities(env, PLUGIN, ["ui.surface"]);
    const allowed = env.hostApi.surfaces.authorizeSurface({ pluginId: PLUGIN, surfaceId: "settings", agentId: AGENT });
    expect(allowed.ok).toBe(true);
  });

  it("resolveAssetPath：合法资源返回版本目录内路径；穿越/缺失拒绝", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "ui.surface" }],
      contributions: { page: [{ id: "settings", name: "Settings", entry: "index.html" }] },
    });
    await env.hostApi.activate(PLUGIN);
    const versionDir = path.join(env.paths.pluginsInstalled, PLUGIN, "1.0.0");
    fs.mkdirSync(path.join(versionDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "assets", "app.js"), "console.log(1)", "utf8");

    const ok = env.hostApi.surfaces.resolveAssetPath({ pluginId: PLUGIN, surfaceId: "settings", assetPath: "assets/app.js" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.path).toBe(path.join(versionDir, "assets", "app.js"));
    }
    const traverse = env.hostApi.surfaces.resolveAssetPath({ pluginId: PLUGIN, surfaceId: "settings", assetPath: "../../etc/passwd" });
    expect(traverse.ok).toBe(false);
    const missing = env.hostApi.surfaces.resolveAssetPath({ pluginId: PLUGIN, surfaceId: "settings", assetPath: "assets/missing.js" });
    expect(missing.ok).toBe(false);
  });
});

describe("HostBroker APIs（platform-mediated）", () => {
  it("config.get / config.set 经 broker 调用（需注册实例身份）", async () => {
    const env = createT5Env();
    installPlugin(env, { pluginId: PLUGIN, version: "1.0.0", permissions: [], contributions: {} });
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 绑定要求至少一项授权
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const instance = env.runtimeHost.getInstance(PLUGIN);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: instance?.runtimeInstanceId ?? "" };

    const setResult = env.broker.call({ identity, apiName: "plugin.host.config.set", args: { config: { theme: "dark" } }, agentId: AGENT });
    expect(setResult.ok).toBe(true);
    const getResult = env.broker.call({ identity, apiName: "plugin.host.config.get", agentId: AGENT });
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual({ theme: "dark" });
    }
  });

  it("secret.list-names 经 broker 调用；伪造身份被拒", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "secret.read-own" }],
      contributions: { secret: [{ id: "key", name: "Key", secretName: "apiKey" }] },
    });
    grantCapabilities(env, PLUGIN, ["secret.read-own"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const instance = env.runtimeHost.getInstance(PLUGIN);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: instance?.runtimeInstanceId ?? "" };

    const list = env.broker.call({ identity, apiName: "plugin.host.secret.list-names" });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toEqual(["apiKey"]);
    }
    const forged = env.broker.call({ identity: { pluginId: PLUGIN, runtimeInstanceId: "forged-id" }, apiName: "plugin.host.secret.list-names" });
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.code).toBe("unauthorized-identity");
    }
  });

  it("secret.read 经 broker 调用需要 secret.read-own 能力", async () => {
    const env = createT5Env();
    installPlugin(env, {
      pluginId: PLUGIN,
      version: "1.0.0",
      permissions: [{ capability: "secret.read-own" }],
      contributions: { secret: [{ id: "key", name: "Key", secretName: "apiKey" }] },
    });
    grantCapabilities(env, PLUGIN, ["secret.read-own"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    env.hostApi.secrets.setSecret({ pluginId: PLUGIN, secretName: "apiKey", value: "hidden-value", actor: USER.actor });
    const instance = env.runtimeHost.getInstance(PLUGIN);
    const identity = { pluginId: PLUGIN, runtimeInstanceId: instance?.runtimeInstanceId ?? "" };
    const result = env.broker.call({ identity, apiName: "plugin.host.secret.read", args: { secretName: "apiKey" }, agentId: AGENT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("hidden-value");
    }
  });
});
