import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import type {
  FileOperation,
  PathCheckResult,
  SandboxDeniedPayload,
  SandboxPreflightDeniedPayload,
} from "../contracts/sandbox.js";
import { sanitizeSensitiveText } from "../runtime/sanitize.js";
import { PathGuard } from "./path-guard.js";
import { buildPathGuardPolicy } from "./policy.js";

/**
 * SandboxService — 沙箱服务组合。
 *
 * 负责：
 * - 创建 PathGuard 实例（基于 Agent 配置和平台路径）
 * - 将拒绝事件写入安全审计日志（~/.opencolorful/logs/security-audit.jsonl）
 *
 * 日志格式为 JSONL（每行一条 JSON），写入失败不抛出异常。
 */
export class SandboxService {
  constructor(
    private readonly pathGuard: PathGuard,
    private readonly agentId: string,
    private readonly auditLogPath: string,
    private readonly sessionId?: string,
  ) {}

  /** 从 Agent settings 和平台路径创建 SandboxService */
  static create(params: {
    agentSettings: AgentSettingsV2;
    agentId: string;
    agentHomeDir: string;
    platformHome: string;
    auditLogPath: string;
    workspaceCwd?: string | null;
    sessionId?: string;
  }): SandboxService {
    const {
      agentSettings,
      agentId,
      agentHomeDir,
      platformHome,
      auditLogPath,
      workspaceCwd,
      sessionId,
    } = params;
    const policy = buildPathGuardPolicy({
      agentSettings,
      agentHomeDir,
      platformHome,
      ...(workspaceCwd !== undefined ? { workspaceCwd } : {}),
    });
    const pathGuard = new PathGuard(policy);
    return new SandboxService(pathGuard, agentId, auditLogPath, sessionId);
  }

  /** 获取 PathGuard 供外部调用 */
  getPathGuard(): PathGuard {
    return this.pathGuard;
  }

  /** 将 PathGuard 的拒绝结果记录为生产安全审计事件。 */
  recordDenied(
    operation: FileOperation,
    targetPath: string,
    result: PathCheckResult,
  ): void {
    this.logDenied({
      operation,
      path: result.canonicalPath || targetPath,
      level: result.level,
      required: result.required,
      reason: result.reason,
      agentId: this.agentId,
    });
  }

  /** 记录 bash 禁用或危险模式命中的生产审计事件。 */
  recordPreflightDenied(command: string, pattern: string): void {
    this.logPreflightDenied({
      command,
      pattern,
      agentId: this.agentId,
    });
  }

  /** 记录 sandbox.denied 事件到审计日志 */
  logDenied(payload: SandboxDeniedPayload): void {
    const entry = {
      timestamp: new Date().toISOString(),
      eventId: crypto.randomUUID(),
      type: "sandbox.denied" as const,
      agentId: payload.agentId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      operation: payload.operation,
      path: sanitizeSensitiveText(payload.path),
      level: payload.level,
      required: payload.required,
      reason: sanitizeSensitiveText(payload.reason),
    };
    this.appendLine(entry);
  }

  /** 记录 sandbox.preflight-denied 事件到审计日志 */
  logPreflightDenied(payload: SandboxPreflightDeniedPayload): void {
    const entry = {
      timestamp: new Date().toISOString(),
      eventId: crypto.randomUUID(),
      type: "sandbox.preflight-denied" as const,
      agentId: payload.agentId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      command: sanitizeSensitiveText(payload.command),
      pattern: sanitizeSensitiveText(payload.pattern),
    };
    this.appendLine(entry);
  }

  // ── private helpers ───────────────────────────────────────────────

  private appendLine(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditLogPath), { recursive: true });
      fs.appendFileSync(this.auditLogPath, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.warn("Failed to write sandbox audit log:", err);
    }
  }
}
