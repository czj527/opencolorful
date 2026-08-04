import { afterEach, describe, expect, it } from "vitest";

import { qualifiedToolName, TOOL_MAX_INPUT_BYTES } from "../../src/runtime/plugins/contributions/tool-contribution.js";
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
// T5 Tool Contribution（plans/phase-12.md §8.1）
// - Agent 可见 namespace pluginId.toolId；
// - 权限前置 + RuntimeHost.invoke 统一包装（plugin.execution.*）；
// - 输入/输出 Schema、大小限制、平台确认策略。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.tools";
const AGENT = "agent-a";

function installToolPlugin(env: T5Env, overrides: { contributions?: Record<string, unknown[]>; permissions?: Array<{ capability: string; reason?: string }> } = {}) {
  installPlugin(env, {
    pluginId: PLUGIN,
    version: "1.0.0",
    permissions: overrides.permissions ?? [{ capability: "tool.register" }],
    contributions:
      overrides.contributions ??
      ({
        tool: [
          {
            id: "echo",
            name: "Echo",
            riskLevel: "low",
            inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
            outputSchema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
          },
          {
            id: "fetch",
            name: "Fetch",
            riskLevel: "medium",
            requiredCapabilities: ["network.connect"],
            inputSchema: { type: "object" },
          },
        ],
      } as Record<string, unknown[]>),
  });
}

afterEach(() => {
  cleanupT5();
});

describe("ToolService：注册与可见性", () => {
  it("listTools 暴露稳定 namespace（pluginId.toolId）", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const tools = env.hostApi.tools.listTools();
    expect(tools.map((tool) => tool.qualifiedName)).toEqual([
      qualifiedToolName(PLUGIN, "echo"),
      qualifiedToolName(PLUGIN, "fetch"),
    ]);
    expect(env.hostApi.tools.getTool(qualifiedToolName(PLUGIN, "echo"))?.name).toBe("Echo");
    expect(env.hostApi.tools.resolveQualifiedName(qualifiedToolName(PLUGIN, "echo"))?.id).toBe("echo");
  });

  it("getTool 对未登记 namespace 返回 undefined", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.tools.getTool("example.tools.missing")).toBeUndefined();
  });
});

describe("ToolService：平台确认策略", () => {
  it("high riskLevel 或高风险能力 → requiresConfirmation=true（插件不能自选）", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const echo = env.hostApi.tools.getTool(qualifiedToolName(PLUGIN, "echo"));
    expect(echo?.requiresConfirmation).toBe(false); // low + 无高风险能力
    const fetch = env.hostApi.tools.getTool(qualifiedToolName(PLUGIN, "fetch"));
    expect(fetch?.requiresConfirmation).toBe(true); // network.connect 高风险
  });

  it("requiredCapabilities 缺失能力时 isHighRiskCapability 不抛错并视为不确认", async () => {
    const env = createT5Env();
    installToolPlugin(env, {
      contributions: {
        tool: [{ id: "t", name: "T", riskLevel: "medium", requiredCapabilities: ["not.a.capability"] }],
      },
    });
    await env.hostApi.activate(PLUGIN);
    const tool = env.hostApi.tools.getTool(qualifiedToolName(PLUGIN, "t"));
    expect(tool?.requiresConfirmation).toBe(false);
  });
});

describe("ToolService：调用（统一 wrapper）", () => {
  it("invoke 走权限前置 + RuntimeHost，产生 plugin.execution.* 生命周期", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    bundleRuntimeOf(env, PLUGIN).registerHandler("echo", (params) => ({ echo: (params as { value: string }).value }));

    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: "hello" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echo: "hello" });
    }
    const started = queryActivity(env.db, "plugin.execution.started");
    const completed = queryActivity(env.db, "plugin.execution.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.operation_id).toBe(started[0]?.operation_id);
    const payload = JSON.parse(completed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({
      contributionKind: "tool",
      id: "echo",
      pluginId: PLUGIN,
      status: "completed",
    });
  });

  it("输入不符合声明 Schema → invalid-input，不调用 runtime", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    let called = false;
    bundleRuntimeOf(env, PLUGIN).registerHandler("echo", () => {
      called = true;
      return {};
    });
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: 42 },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-input");
    }
    expect(called).toBe(false);
  });

  it("输入超过大小限制 → too-large", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const huge = "x".repeat(TOOL_MAX_INPUT_BYTES + 1);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: huge },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too-large");
    }
  });

  it("权限前置拒绝（未授予 tool.register）→ denied + tool.call.denied 活动", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["route.register"]); // 绑定要求至少一项授权；不授 tool.register
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: "x" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("denied");
    }
    const denied = queryActivity(env.db, "tool.call.denied");
    expect(denied).toHaveLength(1);
    const payload = JSON.parse(denied[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({ pluginId: PLUGIN, contributionId: "echo" });
  });

  it("权限前置拒绝 requiredCapabilities（network.connect 未授权）→ denied", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]); // 只授 tool.register，不授 network.connect
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "fetch",
      params: { value: "x" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("denied");
      expect(result.reasonCode).toBe("capability-network.connect");
    }
  });

  it("输出不符合声明 Schema → invalid-output", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    bundleRuntimeOf(env, PLUGIN).registerHandler("echo", () => ({ wrong: "shape" }));
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: "x" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-output");
    }
  });

  it("in-flight 快照不包含该 contribution → not-in-snapshot", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: "x" },
      agentId: AGENT,
      snapshot: {
        version: 1,
        snapshotId: "snap-1",
        pluginId: PLUGIN,
        pluginVersion: "1.0.0",
        runtimeKind: "bundle",
        runtimeInstanceId: "runtime-1",
        grantRevision: 1,
        bindingRevision: 1,
        contributions: ["other-tool"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-in-snapshot");
    }
  });

  it("禁用（deactivate）后旧工具不可调用", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.tools.listTools()).toHaveLength(2);
    await env.hostApi.deactivate(PLUGIN, "plugin_disabled");
    expect(env.hostApi.tools.listTools()).toHaveLength(0);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "echo",
      params: { value: "x" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-registered");
    }
  });

  it("未登记工具 invoke → not-registered", async () => {
    const env = createT5Env();
    installToolPlugin(env);
    grantCapabilities(env, PLUGIN, ["tool.register"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    const result = await env.hostApi.tools.invoke({
      pluginId: PLUGIN,
      contributionId: "missing",
      params: { value: "x" },
      agentId: AGENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-registered");
    }
  });
});
