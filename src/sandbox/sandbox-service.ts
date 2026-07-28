import * as fs from "node:fs";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import type {
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
  ) {}

  /** 从 Agent settings 和平台路径创建 SandboxService */
  static create(params: {
    agentSettings: AgentSettingsV2;
    agentId: string;
    agentHomeDir: string;
    platformHome: string;
    auditLogPath: string;
  }): SandboxService {
    const { agentSettings, agentId, agentHomeDir, platformHome, auditLogPath } =
      params;
    const policy = buildPathGuardPolicy({
      agentSettings,
      agentHomeDir,
      platformHome,
    });
    const pathGuard = new PathGuard(policy);
    return new SandboxService(pathGuard, agentId, auditLogPath);
  }

  /** 获取 PathGuard 供外部调用 */
  getPathGuard(): PathGuard {
    return this.pathGuard;
  }

  /** 记录 sandbox.denied 事件到审计日志 */
  logDenied(payload: SandboxDeniedPayload): void {
    const entry = {
      timestamp: new Date().toISOString(),
      type: "sandbox.denied" as const,
      agentId: payload.agentId,
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
      type: "sandbox.preflight-denied" as const,
      agentId: payload.agentId,
      command: sanitizeSensitiveText(payload.command),
      pattern: sanitizeSensitiveText(payload.pattern),
    };
    this.appendLine(entry);
  }

  // ── private helpers ───────────────────────────────────────────────

  private appendLine(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.auditLogPath, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.warn("Failed to write sandbox audit log:", err);
    }
  }
}
