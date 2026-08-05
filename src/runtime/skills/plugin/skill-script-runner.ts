import crypto from "node:crypto";
import fs from "node:fs";

import type { EventScope, ExecutorRef } from "../../../contracts/observability.js";
import { SKILL_ERROR_CODES, skillRefKey, type SkillErrorCode, type SkillRef } from "../../../contracts/skill-protocol.js";
import type { FileOperation, PathCheckResult } from "../../../contracts/sandbox.js";
import { instrument } from "../../../observability/instrument.js";
import type { SandboxService } from "../../../sandbox/sandbox-service.js";
import type { PathGuard } from "../../../sandbox/path-guard.js";
import { checkBashPreflight } from "../../../sandbox/preflight.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError, assertSkillRef } from "../errors.js";
import { SkillPathError, assertNotSymlinkOrJunction, assertSafeRelativeEntry, safeJoin } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 Skill 脚本执行边界（plans/phase-13.md §12.3 / §18.5）
//
// Skill 只描述脚本使用方式，不直接执行。SkillScriptRunner 是 Agent 调用的
// 唯一受控入口：
// - 只允许 bundle 内 scripts/ 相对路径（canonical 校验，拒绝逃逸/符号链接）；
// - 无 Sandbox 能力（PathGuard 缺失）→ denied + skill_readiness_blocked，
//   绝不降级为宿主进程执行；
// - PathGuard 预检（exec）与危险命令预检（checkBashPreflight）沿用 Phase 9
//   语义；拒绝事件走 sandbox.*.denied + skill.script.denied；
// - 实际执行委托给既有工具/命令执行入口（executor 注入，Phase 9 bash 语义；
//   缺省拒绝，不直接 child_process 执行）；
// - cwd 必须是 Session workspaceCwd；本模块绝不使用 process.cwd() 替代；
// - 事件：skill.script.started → completed/failed/denied（只记录元数据：
//   refKey/相对路径/exitCode/argsCount/稳定 reasonCode，不记录正文/命令/
//   绝对路径）。
// ═══════════════════════════════════════════════════════════════

/** 沙箱端口（SandboxService 形状的子集；T10 注入真实 SandboxService）。 */
export interface SkillScriptSandboxPort {
  readonly pathGuard: PathGuard | null;
  recordDenied(operation: FileOperation, targetPath: string, result: PathCheckResult): void;
  recordPreflightDenied(command: string, pattern: string): void;
}

/** 从 Phase 11 SandboxService 适配沙箱端口。 */
export function sandboxPortFromService(service: SandboxService): SkillScriptSandboxPort {
  return {
    get pathGuard() {
      return service.getPathGuard();
    },
    recordDenied: (operation, targetPath, result) => service.recordDenied(operation, targetPath, result),
    recordPreflightDenied: (command, pattern) => service.recordPreflightDenied(command, pattern),
  };
}

/** 既有工具/命令执行入口（Phase 9 bash 语义：内部含危险命令预检）。 */
export interface SkillScriptExecutor {
  run(input: {
    /** bundle 内脚本绝对路径（已通过 canonical/逃逸/沙箱预检） */
    readonly scriptPath: string;
    readonly args: readonly string[];
    /** 执行 cwd：必须等于 Session workspaceCwd（进程 cwd 不得替代） */
    readonly cwd: string;
  }): SkillScriptExecResult | Promise<SkillScriptExecResult>;
}

export type SkillScriptExecResult =
  | { readonly status: "completed"; readonly exitCode: number }
  | { readonly status: "failed"; readonly reasonCode: string; readonly reason?: string }
  | { readonly status: "denied"; readonly reasonCode: string; readonly reason?: string };

export interface SkillScriptRunnerDeps {
  readonly catalog: SkillCatalog;
  /** 无 Sandbox 能力（缺省/PathGuard null）→ 拒绝（不降级宿主进程执行） */
  readonly sandbox?: SkillScriptSandboxPort;
  /** 执行入口（Phase 9 语义）；缺省 → 拒绝（不直接 child_process） */
  readonly executor?: SkillScriptExecutor;
  /** 插件来源阻断检查（plugin-skill-bridge 注入；可选，缺省放行） */
  readonly blockedSourceCheck?: (skillRef: SkillRef) => { readonly blocked: boolean; readonly reason?: string };
  readonly now?: () => Date;
}

export interface RunSkillScriptInput {
  readonly skillRef: SkillRef;
  /** bundle 内 scripts/ 相对路径（前向斜杠；如 scripts/build.js） */
  readonly scriptRelativePath: string;
  readonly args?: readonly string[];
  /** 执行 cwd：必须是 Session workspaceCwd；process.cwd 不得替代 */
  readonly workspaceCwd: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export type SkillScriptRunResult =
  | { readonly status: "completed"; readonly exitCode: number; readonly durationMs: number }
  | { readonly status: "failed"; readonly reasonCode: SkillErrorCode; readonly reason: string }
  | { readonly status: "denied"; readonly reasonCode: SkillErrorCode; readonly reason: string };

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-script-runner" };

/** 稳定 reasonCode 映射（冻结 SKILL_ERROR_CODES 内选择，文档化拒绝语义）。 */
const DENIED_REASON_CODES = {
  noSandbox: "skill_readiness_blocked",
  sandboxDenied: "skill_readiness_blocked",
  preflightDenied: "skill_readiness_blocked",
  noExecutor: "skill_readiness_blocked",
  blockedSource: "skill_content_read_denied",
  pathEscape: "skill_path_escape",
  notRegularFile: "skill_content_read_denied",
  missingWorkspaceCwd: "skill_operation_failed",
} as const satisfies Record<string, SkillErrorCode>;

export class SkillScriptRunner {
  private readonly now: () => Date;

  constructor(private readonly deps: SkillScriptRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 受控执行 bundle 内脚本。任何拒绝路径返回结构化 denied（含稳定
   * reasonCode），不抛错、不降级宿主进程执行、不记录命令/正文。
   */
  async runScript(input: RunSkillScriptInput): Promise<SkillScriptRunResult> {
    const ref = assertSkillRef(input.skillRef);
    const refKey = skillRefKey(ref);
    const operationId = `skill-script-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = this.now();

    // ── 0. 路径防线：scripts/ 前缀 + canonical（逃逸 → denied 结构化返回）──
    let scriptPath: string;
    try {
      scriptPath = normalizeScriptPath(input.scriptRelativePath);
    } catch (error) {
      return this.deny(input, refKey, "scripts/…", "skill_path_escape", error instanceof Error ? error.message : "脚本路径不合法", operationId);
    }

    // ── 1. 解析 + 来源阻断门（插件卸载/禁用来源 fail-closed）──
    let registered;
    try {
      registered = this.deps.catalog.resolveBySkillRef(ref);
    } catch (error) {
      return this.deny(input, refKey, scriptPath, "skill_unknown_skillref", error instanceof Error ? error.message : "SkillRef 不可解析", operationId);
    }
    if (this.deps.blockedSourceCheck !== undefined) {
      const gate = this.deps.blockedSourceCheck(ref);
      if (gate.blocked) {
        return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.blockedSource, `插件来源不可用（${gate.reason ?? "blocked"}）`, operationId);
      }
    }

    // ── 2. 路径防线：canonical + 符号链接 + 常规文件 ──
    const scriptAbs = safeJoin(registered.rootPath, ...scriptPath.split("/"));
    try {
      assertNotSymlinkOrJunction(scriptAbs, "Skill 脚本");
    } catch (error) {
      if (error instanceof SkillPathError) {
        return this.deny(input, refKey, scriptPath, error.reasonCode, "脚本路径不允许是符号链接或 Junction", operationId);
      }
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.notRegularFile, "脚本文件不可读", operationId);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(scriptAbs);
    } catch {
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.notRegularFile, "脚本文件不存在", operationId);
    }
    if (!stat.isFile()) {
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.notRegularFile, "脚本路径不是常规文件", operationId);
    }

    // ── 3. Sandbox 能力门：无 PathGuard → 拒绝（§12.3 不降级宿主执行）──
    const sandbox = this.deps.sandbox;
    if (sandbox === undefined || sandbox.pathGuard === null) {
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.noSandbox, "无 Sandbox 能力，Skill 脚本拒绝执行（不降级宿主进程）", operationId);
    }

    // ── 4. PathGuard 预检（沿用 Phase 9：拒绝记录 sandbox.path.denied）──
    const guardChecks: Array<{ operation: FileOperation; target: string; what: string }> = [
      { operation: "exec", target: scriptAbs, what: "脚本路径" },
      { operation: "exec", target: input.workspaceCwd, what: "workspaceCwd" },
    ];
    for (const check of guardChecks) {
      const result = sandbox.pathGuard.check(check.operation, check.target);
      if (!result.allowed) {
        sandbox.recordDenied(check.operation, check.target, result);
        return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.sandboxDenied, `${check.what}被沙箱拒绝（${result.required} 需要更高权限）`, operationId);
      }
    }

    // ── 5. workspaceCwd 语义：必须显式提供；process.cwd 不得替代 ──
    const workspaceCwd = input.workspaceCwd.trim();
    if (workspaceCwd.length === 0) {
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.missingWorkspaceCwd, "workspaceCwd 缺失：脚本必须在 Session 工作目录内执行", operationId);
    }

    // ── 6. 执行入口门：缺省拒绝（不直接 child_process）──
    const executor = this.deps.executor;
    if (executor === undefined) {
      return this.deny(input, refKey, scriptPath, DENIED_REASON_CODES.noExecutor, "脚本执行入口未配置，拒绝执行（不降级宿主进程）", operationId);
    }

    // ── 7. 执行：started → completed/failed/denied ──
    this.emit("skill.script.started", "started", operationId, input, {
      skillRefKey: refKey,
      script: scriptPath,
      argsCount: (input.args ?? []).length,
    });
    let result: SkillScriptExecResult;
    try {
      result = await executor.run({ scriptPath: scriptAbs, args: input.args ?? [], cwd: workspaceCwd });
    } catch (error) {
      this.emit("skill.script.failed", "failed", operationId, input, {
        skillRefKey: refKey,
        script: scriptPath,
        reasonCode: "skill_operation_failed",
      });
      return { status: "failed", reasonCode: "skill_operation_failed", reason: error instanceof Error ? error.message.slice(0, 300) : "脚本执行异常" };
    }
    const durationMs = this.now().getTime() - startedAt.getTime();
    if (result.status === "completed") {
      this.emit("skill.script.completed", "completed", operationId, input, {
        skillRefKey: refKey,
        script: scriptPath,
        exitCode: result.exitCode,
        durationMs,
      });
      return { status: "completed", exitCode: result.exitCode, durationMs };
    }
    if (result.status === "denied") {
      this.emit("skill.script.denied", "denied", operationId, input, {
        skillRefKey: refKey,
        script: scriptPath,
        reasonCode: result.reasonCode,
      });
      return { status: "denied", reasonCode: toStableCode(result.reasonCode), reason: result.reason ?? "脚本被拒绝执行" };
    }
    this.emit("skill.script.failed", "failed", operationId, input, {
      skillRefKey: refKey,
      script: scriptPath,
      reasonCode: result.reasonCode,
    });
    return { status: "failed", reasonCode: toStableCode(result.reasonCode), reason: result.reason ?? "脚本执行失败" };
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private deny(
    input: RunSkillScriptInput,
    refKey: string,
    scriptPath: string,
    reasonCode: SkillErrorCode,
    reason: string,
    operationId: string,
  ): SkillScriptRunResult {
    // 预检/沙箱拒绝也记录 skill.script.denied（只带 reasonCode 语义字段）
    this.emit("skill.script.denied", "denied", operationId, input, {
      skillRefKey: refKey,
      script: scriptPath,
      reasonCode,
      ...(reasonCode === "skill_readiness_blocked" ? { deniedBy: "preflight" } : {}),
    });
    return { status: "denied", reasonCode, reason };
  }

  private emit(
    eventName: "skill.script.started" | "skill.script.completed" | "skill.script.failed" | "skill.script.denied",
    status: "started" | "completed" | "failed" | "denied",
    operationId: string,
    input: RunSkillScriptInput,
    attributes: Record<string, string | number | boolean>,
  ): void {
    const scope: EventScope | undefined =
      input.agentId !== undefined
        ? { ownerAgentId: input.agentId, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}), ...(input.turnId !== undefined ? { turnId: input.turnId } : {}) }
        : input.sessionId !== undefined
          ? { sessionId: input.sessionId, ...(input.turnId !== undefined ? { turnId: input.turnId } : {}) }
          : input.turnId !== undefined
            ? { turnId: input.turnId }
            : undefined;
    instrument.activity({
      eventName,
      operationId,
      status,
      actor: { kind: "system", id: "skill-script-runner" },
      executor: EXECUTOR,
      ...(scope !== undefined ? { scope } : {}),
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }
}

/** scripts/ 相对路径规范化：必须位于 bundle 内 scripts/ 下（fail-closed）。 */
function normalizeScriptPath(relativePath: string): string {
  const value = relativePath.trim();
  if (value.length === 0) {
    throw new SkillError("skill_path_escape", "脚本相对路径为空");
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new SkillError("skill_path_escape", "脚本路径必须是 bundle 内 scripts/ 相对路径");
  }
  const segments = normalized.split("/");
  if (segments[0] !== "scripts") {
    throw new SkillError("skill_path_escape", "脚本只能位于 bundle 的 scripts/ 目录内");
  }
  assertSafeRelativeEntry(normalized, "skill_path_escape");
  return normalized;
}

/** executor 返回的 reasonCode 收敛为冻结稳定码（未知 → skill_operation_failed）。 */
function toStableCode(reasonCode: string): SkillErrorCode {
  return (SKILL_ERROR_CODES as readonly string[]).includes(reasonCode)
    ? (reasonCode as SkillErrorCode)
    : "skill_operation_failed";
}

/** 供 T10 接线：Phase 9 bash 工具风格执行入口的便捷适配（preflight + spawn 受控）。 */
export function createBashExecutor(options: {
  readonly spawnCommand: (command: string) => Promise<SkillScriptExecResult>;
}): SkillScriptExecutor {
  return {
    run: async (input) => {
      const command = buildCommand(input.scriptPath, input.args);
      const preflight = checkBashPreflight(command);
      if (!preflight.allowed) {
        return { status: "denied", reasonCode: "skill_readiness_blocked", reason: `危险命令模式被预检拒绝（${preflight.pattern}）` };
      }
      return options.spawnCommand(command);
    },
  };
}

/** 组装执行命令：脚本绝对路径 + 参数（shell 引号转义；cwd 由执行层传入）。 */
function buildCommand(scriptPath: string, args: readonly string[]): string {
  const quoted = [scriptPath, ...args].map((part) => `"${part.replace(/"/g, '\\"')}"`).join(" ");
  return quoted;
}
