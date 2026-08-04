import { afterEach, describe, expect, it } from "vitest";

import {
  RouteContributionError,
  ROUTE_MAX_BODY_BYTES,
  ROUTE_MAX_QUERY_BYTES,
  validateRoutePath,
} from "../../src/runtime/plugins/contributions/route-contribution.js";
import {
  bindAgent,
  bundleRuntimeOf,
  cleanupT5,
  createT5Env,
  grantCapabilities,
  installPlugin,
  queryActivity,
  type T5Env,
} from "./plugin-t5-helper.js";

// ═══════════════════════════════════════════════════════════════
// T5 Route Contribution（plans/phase-12.md §8.4）
// - 固定 namespace /api/plugins/:pluginId/<path>，不能注册根路径/保留子路径；
// - PluginRequestContext 注入身份 + scope + Trace；
// - Body/Query/Response 大小限制。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.routes";
const AGENT = "agent-a";

function installRoutePlugin(env: T5Env, overrides: { contributions?: Record<string, unknown[]> } = {}) {
  installPlugin(env, {
    pluginId: PLUGIN,
    version: "1.0.0",
    permissions: [{ capability: "route.register" }],
    contributions:
      overrides.contributions ??
      ({
        route: [{ id: "hello", name: "Hello", path: "hello", methods: ["GET"] }],
      } as Record<string, unknown[]>),
  });
}

afterEach(() => {
  cleanupT5();
});

describe("RouteService：path 校验", () => {
  it("拒绝注册根路径/空路径", () => {
    expect(() => validateRoutePath(PLUGIN, "")).toThrow(RouteContributionError);
  });

  it("拒绝绝对路径与尾斜杠", () => {
    expect(() => validateRoutePath(PLUGIN, "/hello")).toThrow(RouteContributionError);
    expect(() => validateRoutePath(PLUGIN, "hello/")).toThrow(RouteContributionError);
  });

  it("拒绝父目录穿越段", () => {
    expect(() => validateRoutePath(PLUGIN, "a/../b")).toThrow(RouteContributionError);
    expect(() => validateRoutePath(PLUGIN, "..")).toThrow(RouteContributionError);
  });

  it("拒绝平台保留子路径（assets/manifest/health/config 等）", () => {
    for (const reserved of ["assets", "manifest", "health", "config", "secrets", "diagnostics", "dev"]) {
      expect(() => validateRoutePath(PLUGIN, reserved)).toThrow(/平台保留子路径/);
      expect(() => validateRoutePath(PLUGIN, `${reserved}/x`)).toThrow(/平台保留子路径/);
    }
  });

  it("拒绝不合法段（空格/斜杠/反斜杠）", () => {
    expect(() => validateRoutePath(PLUGIN, "a b")).toThrow(RouteContributionError);
    expect(() => validateRoutePath(PLUGIN, "a\\b")).toThrow(RouteContributionError);
    expect(() => validateRoutePath(PLUGIN, "a//b")).toThrow(RouteContributionError);
  });

  it("合法 path 通过（含子路径与点号段）", () => {
    expect(() => validateRoutePath(PLUGIN, "hello")).not.toThrow();
    expect(() => validateRoutePath(PLUGIN, "sub/deep.route")).not.toThrow();
  });
});

describe("RouteService：激活期校验", () => {
  it("注册保留子路径的 route → 激活失败（fail-closed）", async () => {
    const env = createT5Env();
    installRoutePlugin(env, {
      contributions: { route: [{ id: "bad", name: "Bad", path: "assets/evil" }] },
    });
    await expect(env.hostApi.activate(PLUGIN)).rejects.toThrow(/平台保留子路径/);
    // 激活失败后不残留登记
    expect(env.hostApi.routes.listRoutes()).toHaveLength(0);
  });

  it("不支持的 HTTP 方法 → 激活失败", async () => {
    const env = createT5Env();
    installRoutePlugin(env, {
      contributions: { route: [{ id: "bad", name: "Bad", path: "hello", methods: ["TRACE"] }] },
    });
    await expect(env.hostApi.activate(PLUGIN)).rejects.toThrow(/不支持的 HTTP 方法/);
  });
});

describe("RouteService：handle（统一 wrapper）", () => {
  it("命中路由 → PluginRequestContext 注入身份/scope/query/body 并调用 runtime", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const seen: Array<Record<string, unknown>> = [];
    bundleRuntimeOf(env, PLUGIN).registerHandler("hello", (params) => {
      seen.push(params as Record<string, unknown>);
      return { ok: true, echoed: (params as { body: { name: string } }).body.name };
    });

    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "hello",
      query: { page: "1" },
      body: { name: "t5" },
      agentId: AGENT,
      sessionId: "s1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ ok: true, echoed: "t5" });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      pluginId: PLUGIN,
      method: "GET",
      path: `/api/plugins/${PLUGIN}/hello`,
      query: { page: "1" },
      body: { name: "t5" },
      agentId: AGENT,
      sessionId: "s1",
    });
    const completed = queryActivity(env.db, "plugin.execution.completed");
    const payload = JSON.parse(completed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({ contributionKind: "route", id: "hello" });
  });

  it("未登记路由 → not-found（httpStatus 404）", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "missing",
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      expect(result.httpStatus).toBe(404);
    }
  });

  it("方法不允许 → method-not-allowed（405）", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "POST",
      path: "hello",
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("method-not-allowed");
    }
  });

  it("绝对路径请求被拒绝（不能越出固定 namespace）", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "/api/other",
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
    }
  });

  it("非对象 Body → invalid-body", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "hello",
      body: "not-an-object",
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-body");
    }
  });

  it("Body 超过大小限制 → too-large（413）", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "hello",
      body: { data: "x".repeat(ROUTE_MAX_BODY_BYTES + 1) },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too-large");
    }
  });

  it("Query 超过大小限制 → too-large", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "hello",
      query: { q: "x".repeat(ROUTE_MAX_QUERY_BYTES + 1) },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too-large");
    }
  });

  it("未授予 route.register → denied（403）+ plugin.sandbox.denied 活动", async () => {
    const env = createT5Env();
    installRoutePlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 绑定要求至少一项授权；不授 route.register
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.routes.handle({
      pluginId: PLUGIN,
      method: "GET",
      path: "hello",
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("denied");
    }
    const denied = queryActivity(env.db, "plugin.sandbox.denied");
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });
});
