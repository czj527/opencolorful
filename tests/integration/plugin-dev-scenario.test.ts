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
import { PluginDevScenarioService } from "../../src/runtime/plugins/dev/dev-scenario.js";
import { InMemorySecretStore } from "../../src/runtime/plugins/contributions/secret-contribution.js";
import { BundleRuntime } from "../../src/runtime/plugins/runtimes/bundle-runtime.js";

// ═══════════════════════════════════════════════════════════════
// T9 Dev Scenario（plans/phase-12.md §15 / §19.2）
// 结果断言 / requireConfirmation 断言 / destructive 审批 / surface 打开。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.dev-scenario";
const AGENT = "agent-dev";

interface DevScenarioEnv {
  env: T5Env;
  host: PluginDevHost;
  invoke: PluginDevInvokeService;
  scenario: PluginDevScenarioService;
  sourceDir: string;
}

const activeEnvs: DevScenarioEnv[] = [];

afterEach(() => {
  activeEnvs.splice(0);
  cleanupT5();
});

function writeScenario(sourceDir: string, name: string, body: unknown): void {
  const dir = path.join(sourceDir, "dev", "scenarios");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2), "utf8");
}

function setupScenarioEnv(): DevScenarioEnv {
  const env = createT5Env();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-scn-src-"));
  fs.mkdirSync(path.join(sourceDir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "ui", "settings.html"), "<h1>settings</h1>", "utf8");
  fs.writeFileSync(
    path.join(sourceDir, "manifest.json"),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: PLUGIN,
        name: "Dev Scenario",
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
      },
      null,
      2,
    ),
    "utf8",
  );

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
  });
  host.init();
  const invoke = new PluginDevInvokeService({ host });
  const scenario = new PluginDevScenarioService({ host, invoke });
  const devEnv: DevScenarioEnv = { env, host, invoke, scenario, sourceDir };
  activeEnvs.push(devEnv);
  return devEnv;
}

async function installWithScenario(devEnv: DevScenarioEnv, scenarioName: string, scenarioBody: unknown): Promise<string> {
  writeScenario(devEnv.sourceDir, scenarioName, scenarioBody);
  const state = await devEnv.host.install({ sourceDir: devEnv.sourceDir });
  bindAgent(devEnv.env, AGENT, PLUGIN);
  const runtime = devEnv.host.getDevRuntimeHost().getInstance(PLUGIN)?.runtime as BundleRuntime;
  runtime.registerHandler("echo", (params) => {
    const text = typeof params === "object" && params !== null ? String((params as { text?: unknown }).text ?? "") : "";
    return { echoed: text };
  });
  return state.devRunId;
}

describe("PluginDevScenario run-scenario", () => {
  it("invoke-tool 结果断言 + surface 打开全部通过 → scenario_completed", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "echo-basic", {
      name: "echo-basic",
      destructive: false,
      steps: [
        { kind: "invoke-tool", tool: "echo", args: { text: "hello" }, expect: { result: { echoed: "hello" }, requireConfirmation: false } },
        { kind: "open-surface", surface: "settings-page" },
      ],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "echo-basic", agentId: AGENT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.stepsCompleted).toBe(2);
    }
    expect(queryActivity(devEnv.env.db, "plugin.dev.scenario_completed").length).toBe(1);
    expect(queryActivity(devEnv.env.db, "plugin.surface.opened").length).toBe(1);
  });

  it("结果断言不匹配 → scenario_failed + stepIndex", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "echo-mismatch", {
      name: "echo-mismatch",
      destructive: false,
      steps: [
        { kind: "invoke-tool", tool: "echo", args: { text: "hello" }, expect: { result: { echoed: "nope" } } },
      ],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "echo-mismatch", agentId: AGENT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stepIndex).toBe(0);
      expect(result.error).toMatch(/断言不符/);
    }
    const failed = queryActivity(devEnv.env.db, "plugin.dev.scenario_failed");
    expect(failed.length).toBe(1);
    const payload = JSON.parse(failed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes).toMatchObject({ pluginId: PLUGIN, scenarioName: "echo-mismatch", errorCode: "assertion-mismatch" });
    expect(queryActivity(devEnv.env.db, "plugin.dev.scenario_completed").length).toBe(0);
  });

  it("requireConfirmation 断言不匹配 → 失败", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "echo-confirm", {
      name: "echo-confirm",
      destructive: false,
      steps: [
        { kind: "invoke-tool", tool: "echo", args: { text: "hi" }, expect: { result: { echoed: "hi" }, requireConfirmation: true } },
      ],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "echo-confirm", agentId: AGENT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/requiresConfirmation 断言不符/);
    }
  });

  it("invoke-tool 步骤缺少 agentId → 失败（复用真实权限）", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "echo-basic", {
      name: "echo-basic",
      destructive: false,
      steps: [{ kind: "invoke-tool", tool: "echo", args: { text: "hi" } }],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "echo-basic" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/agentId/);
    }
  });

  it("open-surface 未知 surface → 失败", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "unknown-surface", {
      name: "unknown-surface",
      destructive: false,
      steps: [{ kind: "open-surface", surface: "does-not-exist" }],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "unknown-surface" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Surface 未登记/);
    }
  });

  it("destructive 场景未批准 → scenario_failed（destructive-approval-required）", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "boom", {
      name: "boom",
      destructive: true,
      steps: [{ kind: "open-surface", surface: "settings-page" }],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "boom" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/destructive/);
    }
    const failed = queryActivity(devEnv.env.db, "plugin.dev.scenario_failed");
    const payload = JSON.parse(failed[0]?.payload_json as string) as { attributes: Record<string, unknown> };
    expect(payload.attributes["errorCode"]).toBe("destructive-approval-required");
  });

  it("destructive 场景 approval=true 通过", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "boom", {
      name: "boom",
      destructive: true,
      steps: [{ kind: "open-surface", surface: "settings-page" }],
    });

    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "boom", approval: true });
    expect(result.ok).toBe(true);
    expect(queryActivity(devEnv.env.db, "plugin.dev.scenario_completed").length).toBe(1);
  });

  it("destructive 场景经 approveDestructive 预批准后通过", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "boom", {
      name: "boom",
      destructive: true,
      steps: [{ kind: "open-surface", surface: "settings-page" }],
    });

    devEnv.host.approveDestructive(PLUGIN, devRunId, "boom");
    const result = await devEnv.scenario.runScenario({ pluginId: PLUGIN, devRunId, scenarioName: "boom" });
    expect(result.ok).toBe(true);
  });

  it("loadScenario 对不存在的场景抛 not-found", async () => {
    const devEnv = setupScenarioEnv();
    const devRunId = await installWithScenario(devEnv, "echo-basic", {
      name: "echo-basic",
      destructive: false,
      steps: [{ kind: "open-surface", surface: "settings-page" }],
    });
    expect(() => devEnv.scenario.loadScenario(PLUGIN, devRunId, "missing")).toThrow(/场景不存在/);
  });
});
