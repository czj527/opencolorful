import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { defaultAgentSettings } from "../../src/contracts/agent-settings.js";
import { SandboxService } from "../../src/sandbox/sandbox-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import type { ProducerContext } from "../../src/contracts/observability.js";

const platformHome = path.join(os.homedir(), ".opencolorful");
const agentHomeDir = path.join(platformHome, "agents", "test-agent-svc");

const producer: ProducerContext = {
  component: "unit-test",
  processType: "server",
  processId: "1",
  bootId: "boot-test",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

function makeAgent(overrides: Partial<AgentSettingsV2> = {}): AgentSettingsV2 {
  return { ...defaultAgentSettings(), ...overrides };
}

function makeContext(): { db: ReturnType<typeof openMetadataDatabase> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t5-sandbox-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  instrument.init(new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(directory, "logs"),
    spoolRoot: path.join(directory, "spool"),
  }));
  return { db };
}

function makeService(agentId: string, sessionId?: string): SandboxService {
  return SandboxService.create({
    agentSettings: makeAgent({ defaultCwd: path.join(os.homedir(), "projects", "app") }),
    agentId,
    agentHomeDir,
    platformHome,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("SandboxService", () => {
  // ── 1. create() 为有 defaultCwd 的 Agent 生成有效的 SandboxService ──

  // ── T11 P0-2：addReadOnlyRoots 追加只读根（Skill 根）────────────────
  it("addReadOnlyRoots(): Skill 根只读放行 read，write 仍拒绝；幂等去重", () => {
    const cwd = path.join(os.homedir(), "projects", "skill-app");
    const agent = makeAgent({ defaultCwd: cwd });
    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-1",
      agentHomeDir,
      platformHome,
    });
    const skillRoot = path.join(os.homedir(), ".opencolorful", "skills", "alpha");
    svc.addReadOnlyRoots([skillRoot], "skill-root-read");
    svc.addReadOnlyRoots([skillRoot], "skill-root-read"); // 幂等

    const guard = svc.getPathGuard();
    const readResult = guard.check("read", path.join(skillRoot, "SKILL.md"));
    expect(readResult.allowed).toBe(true);
    expect(readResult.reason).toContain("skill-root-read");
    const writeResult = guard.check("write", path.join(skillRoot, "SKILL.md"));
    expect(writeResult.allowed).toBe(false);
    const readOutside = guard.check("read", path.join(skillRoot, "..", "beta", "SKILL.md"));
    expect(readOutside.allowed).toBe(false); // 只放行根内
  });

  it("create() produces a valid SandboxService for an agent with defaultCwd", () => {
    const cwd = path.join(os.homedir(), "projects", "my-app");
    const agent = makeAgent({ defaultCwd: cwd });

    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-1",
      agentHomeDir,
      platformHome,
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

    const svc = SandboxService.create({
      agentSettings: agent,
      agentId: "agent-2",
      agentHomeDir,
      platformHome,
    });

    expect(svc).toBeInstanceOf(SandboxService);
    const guard = svc.getPathGuard();
    expect(guard).toBeDefined();

    // 没有工作区规则，对任意外部路径写操作应被拒绝
    const result = guard.check("write", path.join(os.homedir(), "some-file.txt"));
    expect(result.allowed).toBe(false);
  });

  // ── 3. recordDenied() → sandbox.path.denied Activity + audit 镜像 ──
  it("recordDenied() writes sandbox.path.denied activity + audit mirror", () => {
    const { db } = makeContext();
    const svc = makeService("agent-3", "session-3");

    svc.recordDenied("write", "/etc/passwd", {
      allowed: false,
      canonicalPath: "/etc/passwd",
      level: "READ_ONLY",
      required: "READ_WRITE",
      reason: "Access denied by default policy",
    });

    const row = db.prepare(
      "SELECT event_name, status, owner_agent_id, session_id, actor_id, payload_json FROM activity_events WHERE event_name = 'sandbox.path.denied'",
    ).get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["status"]).toBe("denied");
    expect(row["owner_agent_id"]).toBe("agent-3");
    expect(row["session_id"]).toBe("session-3");
    expect(row["actor_id"]).toBe("agent-3");
    const payload = JSON.parse(String(row["payload_json"])) as { summaryCode: string; attributes: { operation: string; level: string; required: string } };
    expect(payload.summaryCode).toBe("sandbox_path_denied");
    expect(payload.attributes).toMatchObject({ operation: "write", level: "READ_ONLY", required: "READ_WRITE" });
    // 路径/理由绝不落盘
    expect(JSON.stringify(row)).not.toContain("/etc/passwd");
    expect(JSON.stringify(row)).not.toContain("Access denied");
    // audit 镜像同库
    const mirror = db.prepare("SELECT action FROM audit_events").get() as { action: string };
    expect(mirror.action).toBe("audit.sandbox.path_denied");
  });

  // ── 4. recordPreflightDenied() → sandbox.command.denied + 镜像 ─────
  it("recordPreflightDenied() writes sandbox.command.denied + audit mirror", () => {
    const { db } = makeContext();
    const svc = makeService("agent-4");

    svc.recordPreflightDenied("rm -rf /important", "rm*");

    const row = db.prepare(
      "SELECT event_name, status, payload_json FROM activity_events WHERE event_name = 'sandbox.command.denied'",
    ).get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["status"]).toBe("denied");
    const payload = JSON.parse(String(row["payload_json"])) as { attributes: { pattern: string } };
    expect(payload.attributes.pattern).toBe("rm*");
    // 命令内容绝不落盘
    expect(JSON.stringify(row)).not.toContain("rm -rf");
    const mirror = db.prepare("SELECT action FROM audit_events").get() as { action: string };
    expect(mirror.action).toBe("audit.sandbox.command_denied");
  });

  // ── 5. 未初始化 instrument → no-op 不抛错 ──────────────────────────
  it("denial recording is a no-op without an initialized context", () => {
    instrument.reset();
    const svc = makeService("agent-5");
    expect(() => {
      svc.recordDenied("delete", "/etc/shadow", {
        allowed: false,
        canonicalPath: "/etc/shadow",
        level: "BLOCKED",
        required: "FULL",
        reason: "blocked",
      });
      svc.recordPreflightDenied("dangerous", "danger*");
    }).not.toThrow();
  });

  // ── 6. 多条拒绝正确追加（每条独立操作/事件）────────────────────────
  it("appends multiple denial events without collapsing", () => {
    const { db } = makeContext();
    const svc = makeService("agent-6");

    svc.recordDenied("write", "/first", { allowed: false, canonicalPath: "/first", level: "BLOCKED", required: "READ_WRITE", reason: "First" });
    svc.recordDenied("read", "/second", { allowed: false, canonicalPath: "/second", level: "BLOCKED", required: "READ_ONLY", reason: "Second" });
    svc.recordPreflightDenied("dangerous", "danger*");

    const rows = db.prepare("SELECT event_name FROM activity_events ORDER BY id").all() as Array<{ event_name: string }>;
    expect(rows.map((row) => row.event_name)).toEqual([
      "sandbox.path.denied",
      "sandbox.path.denied",
      "sandbox.command.denied",
    ]);
  });

  // ── 7. 敏感信息（URL/apiKey/Bearer）不入 Activity ──────────────────
  it("sanitizes API keys and sensitive data (never stored at all)", () => {
    const { db } = makeContext();
    const svc = makeService("agent-7");

    svc.recordDenied("read", "https://evil.com?api_key=sk-abc123def456ghi789", {
      allowed: false,
      canonicalPath: "https://evil.com?api_key=sk-abc123def456ghi789",
      level: "BLOCKED",
      required: "READ_ONLY",
      reason: "Authorization: Bearer secret-token-12345 in request",
    });

    const serialized = JSON.stringify(db.prepare("SELECT * FROM activity_events").all());
    // 敏感内容完全不进入存储（路径/理由/URL 一律剔除）
    expect(serialized).not.toContain("sk-abc123def456ghi789");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("evil.com");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("secret-token");
  });
});
