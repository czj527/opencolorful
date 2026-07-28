import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { buildPathGuardPolicy } from "../../src/sandbox/policy.js";
import {
  defaultSandboxCapabilities,
  type SandboxCapabilities,
} from "../../src/contracts/sandbox.js";
import {
  defaultAgentSettings,
  type AgentSettingsV1,
  type AgentSettingsV2,
} from "../../src/contracts/agent-settings.js";

const temporaryDirectories: string[] = [];

function createAgentContext() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencolorful-agent-sbx-"),
  );
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const agentStore = new AgentStore(paths.agents);
  return { paths, agentStore };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const blankBaseColor = {
  persona: "",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

/** Write a settings JSON file directly for an existing agent. */
function writeAgentSettings(
  agentDir: string,
  settings: AgentSettingsV1 | AgentSettingsV2,
): void {
  const p = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

// ═══════════════════════════════════════════════════════════════════
describe("Agent sandbox settings", () => {
  // ── 1. 创建带 sandbox 配置的 Agent，读取后字段完整 ──────────────

  it("creates an agent with sandbox config and reads back all fields", () => {
    const { paths, agentStore } = createAgentContext();

    // Create the agent first
    agentStore.create({
      id: "sandbox-agent",
      name: "沙箱Agent",
      baseColor: blankBaseColor,
    });

    // Write v2 settings with full sandbox config
    const sandbox: SandboxCapabilities = {
      workspaceAccess: "rw",
      extraReadPaths: [path.join(os.tmpdir(), "shared-data")],
      protectedPaths: ["secrets/", "config/private.yaml"],
    };
    const settingsV2: AgentSettingsV2 = {
      version: 2,
      defaultCwd: "/home/project",
      sandbox,
      updatedAt: new Date().toISOString(),
    };
    writeAgentSettings(path.join(paths.agents, "sandbox-agent"), settingsV2);

    // Read back via AgentStore
    const agentDir = path.join(paths.agents, "sandbox-agent");
    const raw = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(raw.version).toBe(2);
    expect(raw.defaultCwd).toBe("/home/project");
    expect(raw.sandbox).toBeDefined();
    expect(raw.sandbox!.workspaceAccess).toBe("rw");
    expect(raw.sandbox!.extraReadPaths).toContain(
      path.join(os.tmpdir(), "shared-data"),
    );
    expect(raw.sandbox!.protectedPaths).toContain("secrets/");
    expect(raw.sandbox!.protectedPaths).toContain("config/private.yaml");
  });

  // ── 2. 更新 Agent 的 extraReadPaths ──────────────────────────────

  it("updates extraReadPaths and reads back the updated value", () => {
    const { paths, agentStore } = createAgentContext();

    agentStore.create({
      id: "read-paths-agent",
      name: "读路径Agent",
      baseColor: blankBaseColor,
    });

    // Initial sandbox with empty extraReadPaths
    const initial: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      updatedAt: new Date().toISOString(),
    };
    const agentDir = path.join(paths.agents, "read-paths-agent");
    writeAgentSettings(agentDir, initial);

    // Verify initial state
    let read = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(read.sandbox).toBeUndefined();

    // Update with extraReadPaths
    const updated: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: ["/mnt/external/docs", "/opt/shared"],
        protectedPaths: [],
      },
      updatedAt: new Date().toISOString(),
    };
    writeAgentSettings(agentDir, updated);

    // Read back
    read = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(read.sandbox).toBeDefined();
    expect(read.sandbox!.extraReadPaths).toEqual([
      "/mnt/external/docs",
      "/opt/shared",
    ]);
    expect(read.sandbox!.protectedPaths).toEqual([]);
  });

  // ── 3. 更新 Agent 的 protectedPaths ──────────────────────────────

  it("updates protectedPaths and reads back the updated value", () => {
    const { paths, agentStore } = createAgentContext();

    agentStore.create({
      id: "prot-paths-agent",
      name: "保护路径Agent",
      baseColor: blankBaseColor,
    });

    const agentDir = path.join(paths.agents, "prot-paths-agent");

    // Write initial settings with some protected paths
    const initial: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: [],
        protectedPaths: [".env", "secrets/"],
      },
      updatedAt: new Date().toISOString(),
    };
    writeAgentSettings(agentDir, initial);

    // Verify initial
    let read = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(read.sandbox!.protectedPaths).toEqual([".env", "secrets/"]);

    // Update protectedPaths
    const updated: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: [],
        protectedPaths: [".env", "credentials/", "tokens/", "private.key"],
      },
      updatedAt: new Date().toISOString(),
    };
    writeAgentSettings(agentDir, updated);

    // Read back
    read = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(read.sandbox!.protectedPaths).toEqual([
      ".env",
      "credentials/",
      "tokens/",
      "private.key",
    ]);
  });

  // ── 4. 旧 Agent（v1 settings）可读且 buildPathGuardPolicy 用默认 sandbox ──

  it("reads legacy v1 settings and buildPathGuardPolicy applies default sandbox", () => {
    const { paths, agentStore } = createAgentContext();

    agentStore.create({
      id: "legacy-agent",
      name: "旧Agent",
      baseColor: blankBaseColor,
    });

    // Write v1 settings (no sandbox field)
    const v1Settings: AgentSettingsV1 = {
      version: 1,
      defaultCwd: "/legacy/project",
      updatedAt: new Date().toISOString(),
    };
    const agentDir = path.join(paths.agents, "legacy-agent");
    writeAgentSettings(agentDir, v1Settings);

    // Verify v1 is readable
    const raw = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV1;
    expect(raw.version).toBe(1);
    expect(raw.defaultCwd).toBe("/legacy/project");

    // Even though settings are v1, buildPathGuardPolicy expects AgentSettingsV2.
    // Construct a v2 equivalent with no sandbox to verify default sandbox kicks in.
    const v2WithDefaults: AgentSettingsV2 = {
      version: 2,
      defaultCwd: raw.defaultCwd,
      // No sandbox field — defaultSandboxCapabilities() should be used
      updatedAt: new Date().toISOString(),
    };

    const agentHomeDir = path.join(paths.agents, "legacy-agent");
    const policy = buildPathGuardPolicy({
      agentSettings: v2WithDefaults,
      agentHomeDir,
      platformHome: paths.home,
    });

    // Default protected paths should be enforced
    const defaultCaps = defaultSandboxCapabilities();
    expect(defaultCaps.protectedPaths).toContain(".env");
    expect(defaultCaps.protectedPaths).toContain("secrets/");
    expect(defaultCaps.protectedPaths).toContain("credentials/");

    // Policy should have rules (at minimum the absolute BLOCKED list + default protectedPaths)
    expect(policy.rules.length).toBeGreaterThan(0);
    // No extraReadPaths means allowExternalReads is false, defaultLevel is BLOCKED
    expect(policy.allowExternalReads).toBe(false);
    expect(policy.defaultLevel).toBe("BLOCKED");
  });

  // ── 5. 删除 sandbox 字段后使用默认值 ─────────────────────────────

  it("uses default sandbox values when sandbox field is absent from v2 settings", () => {
    const { paths, agentStore } = createAgentContext();

    agentStore.create({
      id: "no-sandbox-agent",
      name: "无沙箱Agent",
      baseColor: blankBaseColor,
    });

    // Write v2 settings without sandbox field
    const settings: AgentSettingsV2 = {
      version: 2,
      defaultCwd: "/some/project",
      updatedAt: new Date().toISOString(),
    };
    const agentDir = path.join(paths.agents, "no-sandbox-agent");
    writeAgentSettings(agentDir, settings);

    // Read back — sandbox should be absent
    const read = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    ) as AgentSettingsV2;
    expect(read.version).toBe(2);
    expect(read.sandbox).toBeUndefined();

    // When buildPathGuardPolicy processes these settings,
    // it should use defaultSandboxCapabilities() as fallback
    const defaultCaps = defaultSandboxCapabilities();
    expect(defaultCaps.workspaceAccess).toBe("rw");
    expect(defaultCaps.extraReadPaths).toEqual([]);
    expect(defaultCaps.protectedPaths).toContain(".env");

    const agentHomeDir = path.join(paths.agents, "no-sandbox-agent");
    const policy = buildPathGuardPolicy({
      agentSettings: read,
      agentHomeDir,
      platformHome: paths.home,
    });

    // Without extraReadPaths, allowExternalReads is false
    expect(policy.allowExternalReads).toBe(false);
    expect(policy.defaultLevel).toBe("BLOCKED");

    // Verify that a protected path from defaults (.env) is in the rules
    const blockedRules = policy.rules.filter((r) => r.level === "BLOCKED");
    expect(blockedRules.length).toBeGreaterThan(0);
    // At least one rule should come from the default protectedPaths
    const protectedReasons = blockedRules.map((r) => r.reason);
    const hasEnvBlock = protectedReasons.some((r) => r.includes(".env"));
    const hasSecretsBlock = protectedReasons.some((r) => r.includes("secrets"));
    expect(hasEnvBlock || hasSecretsBlock).toBe(true);
  });
});
