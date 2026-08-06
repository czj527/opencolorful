import * as crypto from "node:crypto";
import * as path from "node:path";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import type {
  FileOperation,
  PathCheckResult,
  PathRule,
} from "../contracts/sandbox.js";
import { instrument } from "../observability/instrument.js";
import { PathGuard } from "./path-guard.js";
import { buildPathGuardPolicy } from "./policy.js";

/**
 * SandboxService — 沙箱服务组合。
 *
 * 负责：
 * - 创建 PathGuard 实例（基于 Agent 配置和平台路径）
 * - 将拒绝事件写入可观测性 Activity 通道（sandbox.path.denied /
 *   sandbox.command.denied，目录级 auditMirror 自动同库落 audit 证据）
 *
 * Phase 11 T5：不再写 logs/security-audit.jsonl（停止双事实源），
 * 事件只进 observability 管线；路径/命令/参数一律不落盘（计划 §6.3：
 * 工作区和工具审计不得保存原始敏感路径、命令或参数），只保留
 * operation/level/required/pattern 等语义字段。
 *
 * T11（P0-2）：addReadOnlyRoots —— 运行时向 PathGuard 追加只读根
 * （当前 turn 冻结的 Skill 根），幂等去重。
 */
export class SandboxService {
  private readonly readOnlyRoots = new Set<string>();

  constructor(
    private readonly pathGuard: PathGuard,
    private readonly agentId: string,
    private readonly sessionId?: string,
  ) {}

  /** 从 Agent settings 和平台路径创建 SandboxService */
  static create(params: {
    agentSettings: AgentSettingsV2;
    agentId: string;
    agentHomeDir: string;
    platformHome: string;
    workspaceCwd?: string | null;
    sessionId?: string;
  }): SandboxService {
    const {
      agentSettings,
      agentId,
      agentHomeDir,
      platformHome,
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
    return new SandboxService(pathGuard, agentId, sessionId);
  }

  /** 获取 PathGuard 供外部调用 */
  getPathGuard(): PathGuard {
    return this.pathGuard;
  }

  /**
   * T11（P0-2）：把目录注册为只读根（READ_ONLY 级别；write/edit/delete/exec
   * 仍拒绝）。用于当前 turn 冻结的 Skill 根——read/grep/find/ls 可在 Skill
   * 目录工作；正文读取优先走 SkillContentService 受控路径（哈希/预算），
   * 本规则只兜底沙箱策略层。幂等：同一根重复注册不产生重复规则。
   */
  addReadOnlyRoots(roots: readonly string[], reason: string): void {
    this.setReadOnlyRoots([...this.readOnlyRoots, ...roots], reason);
  }

  /**
   * T12（P0-1）：整体替换某一类只读根（按 reason 分组）。每轮 turn 冻结后
   * 调用，保证上一轮解绑/停用/插件禁用后的旧 Skill 根被移除——否则 PathGuard
   * 动态规则残留会让回退原始读取绕过当前 Turn Snapshot。幂等：同根不重复。
   */
  setReadOnlyRoots(roots: readonly string[], reason: string): void {
    const normalized = [...new Set(roots.map((root) => path.resolve(root)))];
    const rules: PathRule[] = normalized.map((root) => ({
      path: root.endsWith(path.sep) ? root : `${root}${path.sep}`,
      level: "READ_ONLY",
      reason,
    }));
    this.pathGuard.replaceRulesByReason(reason, rules);
    this.readOnlyRoots.clear();
    for (const root of normalized) {
      this.readOnlyRoots.add(root);
    }
  }

  /** 将 PathGuard 的拒绝结果记录为 sandbox.path.denied（+audit 镜像）。 */
  recordDenied(
    operation: FileOperation,
    targetPath: string,
    result: PathCheckResult,
  ): void {
    // 路径/理由可能含绝对路径，一律不落盘；只保留语义字段
    void targetPath;
    instrument.activity({
      eventName: "sandbox.path.denied",
      status: "denied",
      operationId: `sandbox-${this.agentId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      actor: { kind: "agent", id: this.agentId },
      executor: { kind: "agent", id: this.agentId },
      scope: this.scope(),
      payload: {
        summaryCode: "sandbox_path_denied",
        attributes: {
          operation,
          level: result.level,
          ...(result.required !== undefined ? { required: result.required } : {}),
        },
      },
    });
  }

  /** 记录 bash 禁用或危险模式命中为 sandbox.command.denied（+audit 镜像）。 */
  recordPreflightDenied(command: string, pattern: string): void {
    // 命令本身可能含参数/敏感内容，一律不落盘；pattern 是策略标识
    void command;
    instrument.activity({
      eventName: "sandbox.command.denied",
      status: "denied",
      operationId: `sandbox-${this.agentId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      actor: { kind: "agent", id: this.agentId },
      executor: { kind: "agent", id: this.agentId },
      scope: this.scope(),
      payload: {
        summaryCode: "sandbox_command_denied",
        attributes: { pattern: pattern.slice(0, 200) },
      },
    });
  }

  private scope(): { ownerAgentId: string; sessionId?: string } {
    return this.sessionId !== undefined
      ? { ownerAgentId: this.agentId, sessionId: this.sessionId }
      : { ownerAgentId: this.agentId };
  }
}
