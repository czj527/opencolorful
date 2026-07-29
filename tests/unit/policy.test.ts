import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { buildPathGuardPolicy } from "../../src/sandbox/policy.js";
import type { AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { defaultAgentSettings } from "../../src/contracts/agent-settings.js";

const platformHome = path.join(os.homedir(), ".opencolorful");
const agentHomeDir = path.join(platformHome, "agents", "test-agent-1");

function makeAgent(overrides: Partial<AgentSettingsV2> = {}): AgentSettingsV2 {
  return { ...defaultAgentSettings(), ...overrides };
}

describe("buildPathGuardPolicy", () => {
  // ── 1. 基础策略：有 defaultCwd 的 Agent ───────────────────────────
  it("generates correct rules for an agent with defaultCwd", () => {
    const cwd = path.join(os.homedir(), "projects", "my-app");
    const agent = makeAgent({ defaultCwd: cwd });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    // 必须包含绝对 BLOCKED 清单
    const paths = policy.rules.map((r) => r.path);
    expect(paths.some((p) => p.includes(".ssh"))).toBe(true);
    expect(paths.some((p) => p.includes(".aws"))).toBe(true);

    // 包含 FULL 工作目录规则
    const fullRule = policy.rules.find((r) => r.level === "FULL");
    expect(fullRule).toBeDefined();
    expect(fullRule!.path).toContain("my-app");

    // 包含 READ_WRITE agentHomeDir 规则
    const rwRule = policy.rules.find((r) => r.level === "READ_WRITE");
    expect(rwRule).toBeDefined();
    expect(rwRule!.path).toContain("test-agent-1");
  });

  // ── 2. 无 defaultCwd 的 Agent → 无工作目录规则 ────────────────────
  it("does not include a FULL workspace rule when defaultCwd is null", () => {
    const agent = makeAgent({ defaultCwd: null });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const fullRules = policy.rules.filter((r) => r.level === "FULL");
    expect(fullRules.length).toBe(0);
  });

  // ── 3. 有 extraReadPaths 的 Agent → 包含 READ_ONLY 规则 ───────────
  it("includes READ_ONLY rules from extraReadPaths", () => {
    const agent = makeAgent({
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: ["/usr/share/docs", "/opt/data"],
        protectedPaths: [],
      },
    });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const roRules = policy.rules.filter(
      (r) => r.level === "READ_ONLY" && r.reason.includes("Extra read path"),
    );
    expect(roRules.length).toBe(2);
    expect(roRules[0]!.path).toContain("docs");
    expect(roRules[1]!.path).toContain("data");

    // allowExternalReads 固定为 false（fail-closed，不因 extraReadPaths 开放全局）
    expect(policy.allowExternalReads).toBe(false);
    expect(policy.defaultLevel).toBe("BLOCKED");
  });

  // ── 4. 有 protectedPaths 的 Agent → 包含 BLOCKED 规则 ────────────
  it("includes BLOCKED rules from protectedPaths", () => {
    const agent = makeAgent({
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: [],
        protectedPaths: [".env", "secrets/"],
      },
    });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const blockedRules = policy.rules.filter(
      (r) => r.level === "BLOCKED" && r.reason.includes("Protected path"),
    );
    expect(blockedRules.length).toBe(2);
  });

  // ── 5. 多个 protectedPaths → 每个一条规则 ─────────────────────────
  it("creates one rule per protectedPath entry", () => {
    const agent = makeAgent({
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: [],
        protectedPaths: ["secrets/", "credentials/", ".env", "config/private/"],
      },
    });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const blockedRules = policy.rules.filter(
      (r) => r.level === "BLOCKED" && r.reason.includes("Protected path"),
    );
    expect(blockedRules.length).toBe(4);
  });

  // ── 6. defaultLevel 为 BLOCKED（无 extraReadPaths 时）─────────────
  it("sets defaultLevel to BLOCKED when there are no extraReadPaths", () => {
    const agent = makeAgent({
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: [],
        protectedPaths: [],
      },
    });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    expect(policy.defaultLevel).toBe("BLOCKED");
    expect(policy.allowExternalReads).toBe(false);
  });

  // ── 7. 没有 sandbox 字段时 → 使用默认值（不抛异常）──────────────
  it("uses default sandbox capabilities when sandbox field is missing", () => {
    // 直接构造不带 sandbox 字段的 agent
    const agent: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      updatedAt: new Date().toISOString(),
    };
    // 不应抛异常
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    expect(policy.rules.length).toBeGreaterThan(0);
    // 默认有 protectedPaths，所以应有对应的 BLOCKED 规则
    const blockedRules = policy.rules.filter(
      (r) => r.level === "BLOCKED" && r.reason.includes("Protected path"),
    );
    expect(blockedRules.length).toBeGreaterThanOrEqual(2);
  });

  // ── 8. 绝对 BLOCKED 清单始终存在 ──────────────────────────────────
  it("always includes the absolute BLOCKED list regardless of agent config", () => {
    // 最小化 agent：无 sandbox、无 defaultCwd
    const agent: AgentSettingsV2 = {
      version: 2,
      defaultCwd: null,
      updatedAt: new Date().toISOString(),
    };
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const paths = policy.rules.map((r) => r.path);

    // ~/.ssh（现在以路径分隔符结尾，用 includes 匹配）
    const sep = path.sep;
    expect(paths.some((p) => p.includes(`${sep}.ssh`))).toBe(true);
    // ~/.aws
    expect(paths.some((p) => p.includes(`${sep}.aws`))).toBe(true);
    // platform auth/ 目录
    expect(paths.some((p) => p.includes("auth") && p.endsWith(sep))).toBe(true);

    // BLOCKED 级别的规则数至少包含绝对清单（.ssh + .aws + auth/ + .env = 4）
    // 再加上默认 protectedPaths 的项
    const blockedRules = policy.rules.filter((r) => r.level === "BLOCKED");
    expect(blockedRules.length).toBeGreaterThanOrEqual(4);
  });

  // ── 9. Platform config 目录规则存在 ───────────────────────────────
  it("includes a READ_ONLY rule for the platform config directory", () => {
    const agent = makeAgent();
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    const configRule = policy.rules.find(
      (r) => r.level === "READ_ONLY" && r.reason.includes("Platform configuration"),
    );
    expect(configRule).toBeDefined();
    expect(configRule!.path).toContain("config");
    expect(configRule!.path.endsWith(path.sep)).toBe(true);
  });

  // ── 10. 规则顺序：高优先级在前 ────────────────────────────────────
  it("orders rules correctly: BLOCKED first, then READ_ONLY, then FULL/RW", () => {
    const agent = makeAgent({
      defaultCwd: path.join(os.homedir(), "projects", "app"),
      sandbox: {
        workspaceAccess: "rw",
        extraReadPaths: ["/data"],
        protectedPaths: [".env"],
      },
    });
    const policy = buildPathGuardPolicy({ agentSettings: agent, agentHomeDir, platformHome });

    // 前几条应为 BLOCKED（绝对清单 + protectedPaths），然后 READ_ONLY，最后 FULL/RW
    const levels = policy.rules.map((r) => r.level);
    // 第一条应为 BLOCKED
    expect(levels[0]).toBe("BLOCKED");
    // READ_ONLY 前面的规则应全部是 BLOCKED
    const firstReadOnlyIdx = levels.indexOf("READ_ONLY");
    if (firstReadOnlyIdx > 0) {
      expect(levels.slice(0, firstReadOnlyIdx).every((l) => l === "BLOCKED")).toBe(true);
    }
    // FULL/RW 应在 READ_ONLY 之后
    const firstFullIdx = levels.indexOf("FULL");
    if (firstFullIdx > 0 && firstReadOnlyIdx > 0) {
      expect(firstFullIdx).toBeGreaterThan(firstReadOnlyIdx);
    }
  });
});
