import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { defaultAgentSettings } from "../../src/contracts/agent-settings.js";
import type {
  SandboxDeniedPayload,
  SandboxPreflightDeniedPayload,
} from "../../src/contracts/sandbox.js";
import { SandboxService } from "../../src/sandbox/sandbox-service.js";

const platformHome = path.join(os.homedir(), ".opencolorful");
const agentHomeDir = path.join(platformHome, "agents", "test-agent-svc");

function makeAgent(overrides: Partial<AgentSettingsV2> = {}): AgentSettingsV2 {
  return { ...defaultAgentSettings(), ...overrides };
}

function tempAuditPath(): string {
  return path.join(os.tmpdir(), `ocf-test-audit-${Date.now()}.jsonl`);
}

describe("SandboxService", () => {
  // ── 1. create() 为有 defaultCwd 的 Agent 生成有效的 SandboxService ──
  it("create() produces a valid SandboxService for an agent with defaultCwd", () => {
    const cwd = path.join(os.homedir(), "projects", "my-app");
    const agent = makeAgent({ defaultCwd: cwd });
    const auditPath = tempAuditPath();

    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-1",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
    });

    expect(svc).toBeInstanceOf(SandboxService);
    const guard = svc.getPathGuard();
    expect(guard).toBeDefined();

    // PathGuard 应允许访问工作区
    const result = guard.check("read", path.join(cwd, "file.txt"));
    expect(result.allowed).toBe(true);
  });

  // ── 2. create() 为无 defaultCwd 的 Agent 也能生成（降级处理）────────
  it("create() works for an agent without defaultCwd (degraded)", () => {
    const agent = makeAgent({ defaultCwd: null });
    const auditPath = tempAuditPath();

    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-2",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
    });

    expect(svc).toBeInstanceOf(SandboxService);
    const guard = svc.getPathGuard();
    expect(guard).toBeDefined();

    // 没有工作区规则，对任意外部路径写操作应被拒绝
    const result = guard.check("write", path.join(os.homedir(), "some-file.txt"));
    expect(result.allowed).toBe(false);
  });

  // ── 3. logDenied() 写入 auditLogPath 一行 JSON（用临时目录）─────────
  it("logDenied() appends one JSON line to the audit log", () => {
    const auditPath = tempAuditPath();
    const agent = makeAgent({ defaultCwd: path.join(os.homedir(), "projects", "app") });
    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-3",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
      sessionId: "session-3",
    });

    const payload: SandboxDeniedPayload = {
      operation: "write",
      path: "/etc/passwd",
      level: "READ_ONLY",
      required: "READ_WRITE",
      reason: "Access denied by default policy",
      agentId: "agent-3",
    };

    svc.logDenied(payload);

    // 读取日志文件并验证
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    expect(content).toBeTruthy();

    const entry = JSON.parse(content);
    expect(entry.type).toBe("sandbox.denied");
    expect(entry.agentId).toBe("agent-3");
    expect(entry.sessionId).toBe("session-3");
    expect(entry.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.operation).toBe("write");
    expect(entry.path).toBeDefined();
    expect(entry.level).toBe("READ_ONLY");
    expect(entry.required).toBe("READ_WRITE");
    expect(entry.reason).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    // 应为 ISO 8601 格式
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── 4. logPreflightDenied() 正确写入 ────────────────────────────────
  it("logPreflightDenied() correctly writes a preflight denial entry", () => {
    const auditPath = tempAuditPath();
    const agent = makeAgent();
    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-4",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
    });

    const payload: SandboxPreflightDeniedPayload = {
      command: "rm -rf /important",
      pattern: "rm*",
      agentId: "agent-4",
    };

    svc.logPreflightDenied(payload);

    const content = fs.readFileSync(auditPath, "utf-8").trim();
    expect(content).toBeTruthy();

    const entry = JSON.parse(content);
    expect(entry.type).toBe("sandbox.preflight-denied");
    expect(entry.agentId).toBe("agent-4");
    expect(entry.command).toBeDefined();
    expect(entry.pattern).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── 5. 写入失败不崩溃（父路径是文件）──────────────────────────────
  it("logDenied() does not throw when write fails", () => {
    const agent = makeAgent();
    const blockingFile = tempAuditPath();
    fs.writeFileSync(blockingFile, "not-a-directory");
    const invalidPath = path.join(blockingFile, "should-fail.jsonl");

    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-5",
      agentHomeDir,
      platformHome,
      auditLogPath: invalidPath,
    });

    const payload: SandboxDeniedPayload = {
      operation: "delete",
      path: "/etc/shadow",
      level: "BLOCKED",
      required: "FULL",
      reason: "SSH keys directory is blocked",
      agentId: "agent-5",
    };

    try {
      expect(() => svc.logDenied(payload)).not.toThrow();
    } finally {
      fs.rmSync(blockingFile, { force: true });
    }
  });

  // ── 6. 多条日志正确追加（不覆盖）────────────────────────────────────
  it("appends multiple log entries without overwriting", () => {
    const auditPath = tempAuditPath();
    const agent = makeAgent({ defaultCwd: path.join(os.homedir(), "projects", "multi") });
    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-6",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
    });

    svc.logDenied({
      operation: "write",
      path: "/first",
      level: "BLOCKED",
      required: "READ_WRITE",
      reason: "First denial",
      agentId: "agent-6",
    });

    svc.logDenied({
      operation: "read",
      path: "/second",
      level: "BLOCKED",
      required: "READ_ONLY",
      reason: "Second denial",
      agentId: "agent-6",
    });

    svc.logPreflightDenied({
      command: "dangerous",
      pattern: "danger*",
      agentId: "agent-6",
    });

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries[0].type).toBe("sandbox.denied");
    expect(entries[0].reason).toContain("First denial");
    expect(entries[1].type).toBe("sandbox.denied");
    expect(entries[1].reason).toContain("Second denial");
    expect(entries[2].type).toBe("sandbox.preflight-denied");
  });

  // ── 7. API Key 敏感信息在日志中脱敏 ─────────────────────────────────
  it("sanitizes API keys and sensitive data in log entries", () => {
    const auditPath = tempAuditPath();
    const agent = makeAgent();
    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-7",
      agentHomeDir,
      platformHome,
      auditLogPath: auditPath,
    });

    // 构造一个包含敏感信息的 payload（模拟恶意路径或理由）
    svc.logDenied({
      operation: "read",
      path: "https://evil.com?api_key=sk-abc123def456ghi789",
      level: "BLOCKED",
      required: "READ_ONLY",
      reason: "Authorization: Bearer secret-token-12345 in request",
      agentId: "agent-7",
    });

    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);

    // 整个 URL（含内嵌 API key）被 URL_PATTERN 率先匹配，整体替换为 [URL]
    expect(entry.path).not.toContain("sk-abc123def456ghi789");
    expect(entry.path).not.toContain("api_key");
    expect(entry.path).not.toContain("evil.com");
    expect(entry.path).toBe("[URL]");

    // Authorization header 应被替换为 [AUTH_HEADER]
    expect(entry.reason).not.toContain("Bearer secret-token-12345");
    expect(entry.reason).toContain("[AUTH_HEADER]");
  });

  // ── cleanup ────────────────────────────────────────────────────────
  afterEach(() => {
    // 清理可能遗留的临时文件（不抛异常）
    // 注意：这无法精确匹配所有测试创建的路径，作为尽力清理
  });
});
