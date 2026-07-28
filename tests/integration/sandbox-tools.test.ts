import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { PathGuard } from "../../src/sandbox/path-guard.js";
import { buildPathGuardPolicy } from "../../src/sandbox/policy.js";
import { checkBashPreflight } from "../../src/sandbox/preflight.js";
import { SandboxService } from "../../src/sandbox/sandbox-service.js";
import { type AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { defaultSandboxCapabilities } from "../../src/contracts/sandbox.js";

const temporaryDirectories: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-sbx-tools-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Construct a minimal AgentSettingsV2 for testing. */
function testAgentSettings(overrides: Partial<AgentSettingsV2> = {}): AgentSettingsV2 {
  return {
    version: 2,
    defaultCwd: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a PathGuard with temporary agentHome and platformHome directories.
 * DefaultCwd is set to a writable temp workspace so we can test FULL access.
 */
function buildGuard(params: {
  workspace: string;
  extraReadPaths?: string[];
  protectedPaths?: string[];
  defaultCwd?: string | null;
}) {
  const { workspace, defaultCwd } = params;
  const agentHome = tempHome();
  const platformHome = tempHome();

  // Ensure the workspace directory and extraReadPaths exist
  fs.mkdirSync(workspace, { recursive: true });
  for (const rp of params.extraReadPaths ?? []) {
    fs.mkdirSync(rp, { recursive: true });
  }

  const sandboxOverride =
    params.extraReadPaths || params.protectedPaths
      ? {
          sandbox: {
            ...defaultSandboxCapabilities(),
            extraReadPaths: params.extraReadPaths ?? [],
            protectedPaths: params.protectedPaths ?? [],
          },
        }
      : {};

  const settings = testAgentSettings({
    defaultCwd: defaultCwd ?? null,
    ...sandboxOverride,
  });

  const policy = buildPathGuardPolicy({
    agentSettings: settings,
    agentHomeDir: agentHome,
    platformHome,
  });

  return { guard: new PathGuard(policy), policy, agentHome, platformHome };
}

// ═══════════════════════════════════════════════════════════════════
describe("Sandbox file-tool interception", () => {
  // ── 1. write 工具被 BLOCKED 区域拒绝 ─────────────────────────────

  it("rejects write to BLOCKED SSH directory", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    const sshDir = path.join(os.homedir(), ".ssh");
    const result = guard.check("write", sshDir);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SSH");
    expect(result.level).toBe("BLOCKED");
  });

  it("rejects write to BLOCKED AWS credentials directory", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    const awsDir = path.join(os.homedir(), ".aws");
    const result = guard.check("write", awsDir);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("AWS");
  });

  // ── 2. read 工具在 READ_ONLY 区域允许 ────────────────────────────

  it("allows read from extraReadPaths (READ_ONLY area)", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-extra-"));
    temporaryDirectories.push(extraDir);
    // Create a test file in the extra read path
    const testFile = path.join(extraDir, "data.txt");
    fs.writeFileSync(testFile, "hello");

    const { guard } = buildGuard({
      workspace,
      extraReadPaths: [extraDir],
    });

    const result = guard.check("read", testFile);
    expect(result.allowed).toBe(true);
  });

  // ── 3. write 工具在 FULL 区域允许 ────────────────────────────────

  it("allows write to agent working directory (FULL area)", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const testFile = path.join(workspace, "output.txt");

    const { guard } = buildGuard({ workspace, defaultCwd: workspace });

    const result = guard.check("write", testFile);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe("FULL");
  });

  // ── 4. 越权操作返回友好错误消息（包含 reason） ──────────────────

  it("returns a user-friendly error message including the reason field on denial", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    const sshDir = path.join(os.homedir(), ".ssh");
    const result = guard.check("write", sshDir);
    expect(result.allowed).toBe(false);
    // reason should contain human-readable explanation
    expect(result.reason).toContain("denied");
    expect(result.reason).toContain("SSH");
    // result contains required vs granted level
    expect(result.required).toBe("READ_WRITE");
    expect(result.level).toBe("BLOCKED");
  });

  it("returns descriptive denial reason for non-existent path outside workspace", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    // A path that does not exist and is outside any allow-listed area
    const ghostPath = path.join(os.tmpdir(), "oc-nonexistent-dir-" + Date.now(), "file.txt");
    const result = guard.check("write", ghostPath);
    expect(result.allowed).toBe(false);
    // Default policy is BLOCKED, message should mention default policy
    expect(result.reason).toContain("default");
  });

  // ── 5. 危险 bash 命令被 preflight 拦截 ──────────────────────────

  it("preflight blocks format C:", () => {
    const result = checkBashPreflight("format C: /FS:NTFS");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("format");
    }
  });

  it("preflight blocks del /s C:\\", () => {
    const result = checkBashPreflight("del /s C:\\Windows\\Temp\\*");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("del");
    }
  });

  it("preflight blocks takeown /f", () => {
    const result = checkBashPreflight("takeown /f C:\\Windows\\System32\\file.dll");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("takeown");
    }
  });

  // ── 6. 安全 bash 命令通过 preflight ──────────────────────────────

  it("preflight allows safe bash commands like ls -la", () => {
    const result = checkBashPreflight("ls -la /tmp");
    expect(result.allowed).toBe(true);
  });

  it("preflight allows npm install", () => {
    const result = checkBashPreflight("npm install --save express");
    expect(result.allowed).toBe(true);
  });

  // ── 7. 不存在的路径被默认策略拒绝（BLOCKED 兜底） ───────────────

  it("rejects write to non-existent path by default BLOCKED fallback", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    const randomPath = path.join(os.tmpdir(), "should-not-exist-" + crypto.randomUUID(), "file.txt");
    const result = guard.check("write", randomPath);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
  });

  it("rejects read to non-existent path outside workspace when allowExternalReads is false", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const { guard } = buildGuard({ workspace });

    const randomPath = path.join(os.tmpdir(), "no-read-dir-" + crypto.randomUUID(), "secret.txt");
    const result = guard.check("read", randomPath);
    // Without extraReadPaths, allowExternalReads is false, default is BLOCKED
    expect(result.allowed).toBe(false);
  });

  // ── 8. Agent 绑定沙箱配置后工具权限生效 ─────────────────────────

  it("buildPathGuardPolicy respects extraReadPaths in agent sandbox config", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-extra-"));
    temporaryDirectories.push(extraDir);

    const { guard } = buildGuard({
      workspace,
      extraReadPaths: [extraDir],
    });

    // Write should still be blocked on the extraReadPaths area (READ_ONLY only)
    const readResult = guard.check("read", extraDir);
    expect(readResult.allowed).toBe(true);

    const writeResult = guard.check("write", path.join(extraDir, "new.txt"));
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.reason).toContain("denied");
  });

  it("buildPathGuardPolicy respects protectedPaths in agent sandbox config", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const protectedDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-prot-"));
    temporaryDirectories.push(protectedDir);

    const { guard } = buildGuard({
      workspace,
      protectedPaths: [protectedDir],
    });

    // Protected path should be BLOCKED even for read
    const result = guard.check("read", protectedDir);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
    expect(result.reason).toContain("Protected");
  });

  // ── 9. SandboxService 创建与审计日志 ─────────────────────────────

  it("SandboxService.create produces a working PathGuard and writes audit log on denial", () => {
    const opencolorfulHome = tempHome();
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: opencolorfulHome });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
    temporaryDirectories.push(workspace);
    const auditLogPath = path.join(paths.logs, "security-audit.jsonl");

    const service = SandboxService.create({
      agentSettings: testAgentSettings({ defaultCwd: workspace }),
      agentId: "test-agent",
      agentHomeDir: paths.agents + "/test-agent",
      platformHome: paths.home,
      auditLogPath,
    });

    const guard = service.getPathGuard();
    expect(guard).toBeInstanceOf(PathGuard);

    // Verify the guard works
    const result = guard.check("write", workspace + "/test.txt");
    expect(result.allowed).toBe(true);

    // Ensure logs directory exists
    fs.mkdirSync(paths.logs, { recursive: true });

    // Log a denied event
    service.logDenied({
      operation: "write",
      path: os.homedir() + "/.ssh/id_rsa",
      level: "BLOCKED",
      required: "READ_WRITE",
      reason: "SSH keys directory is blocked",
      agentId: "test-agent",
    });

    // Audit log should have been created
    expect(fs.existsSync(auditLogPath)).toBe(true);
    const logContent = fs.readFileSync(auditLogPath, "utf8");
    expect(logContent).toContain("sandbox.denied");
    expect(logContent).toContain("test-agent");
  });
});
