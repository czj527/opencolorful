import fs from "node:fs";
import path from "node:path";

import type { FileOperation, PathCheckResult } from "../contracts/sandbox.js";
import type { ToolMode } from "../contracts/session-settings.js";
import { READ_ONLY_TOOLS, ALL_TOOLS } from "../contracts/session-settings.js";
import type { PathGuard } from "../sandbox/path-guard.js";
import { checkBashPreflight } from "../sandbox/preflight.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";

/**
 * ToolPolicy -- 工具策略与沙箱守卫。
 *
 * 职责：
 * 1. 根据 ToolMode 解析可用的工具列表
 * 2. 集成 PathGuard 进行文件路径沙箱检查
 * 3. Bash 命令预检（preflight）
 *
 * 向后兼容：未注入 PathGuard 时，所有沙箱检查默认放行。
 */
export class ToolPolicy {
  private pathGuard: PathGuard | null = null;
  private sandboxService: SandboxService | null = null;

  // ── PathGuard 注入 ───────────────────────────────────────────────

  /** 注入或移除 PathGuard。传 null 可清除沙箱（降级模式）。 */
  setPathGuard(guard: PathGuard | null): void {
    this.pathGuard = guard;
    this.sandboxService = null;
  }

  /** 注入完整沙箱服务，使路径检查与安全审计使用同一策略实例。 */
  setSandboxService(service: SandboxService | null): void {
    this.sandboxService = service;
    this.pathGuard = service?.getPathGuard() ?? null;
  }

  /** 是否已配置沙箱 */
  get hasSandbox(): boolean {
    return this.pathGuard !== null;
  }

  // ── 工具列表解析（原有逻辑，不变） ───────────────────────────────

  resolveTools(mode: ToolMode, cwd?: string, confirmed?: boolean): string[] {
    switch (mode) {
      case "off":
        return [];
      case "read-only":
        return [...READ_ONLY_TOOLS];
      case "all":
        // fail-safe：未确认工作区时降级为只读工具，不阻塞上层保存状态
        if (confirmed === true) {
          this.validateAllMode(cwd, confirmed);
          return [...ALL_TOOLS];
        }
        return [...READ_ONLY_TOOLS];
      default:
        throw new Error(`未知工具模式: ${mode}`);
    }
  }

  shouldDisableAllTools(mode: ToolMode): boolean {
    return mode === "off";
  }

  // ── 扩展：含沙箱警告的工具权限解析 ───────────────────────────────

  /**
   * 解析工具权限，返回工具列表和沙箱警告。
   *
   * 相比 resolveTools，额外检查 cwd 是否在沙箱允许范围内。
   * 如果 cwd 被沙箱拒绝，不会阻止工具列表返回（降级运行），
   * 但会在 warnings 中给出提示。
   */
  resolveToolPermissions(
    mode: ToolMode,
    cwd?: string,
    confirmed?: boolean,
  ): { tools: string[]; sandboxWarnings: string[] } {
    const tools = this.resolveTools(mode, cwd, confirmed);
    const sandboxWarnings: string[] = [];

    if (mode === "all" && confirmed !== true) {
      sandboxWarnings.push("工作区未确认，已降级为只读工具");
    }

    if (this.pathGuard && cwd) {
      const result = this.pathGuard.check("read", cwd);
      if (!result.allowed) {
        sandboxWarnings.push(result.reason);
      }
    }

    return { tools, sandboxWarnings };
  }

  // ── 文件路径沙箱检查 ─────────────────────────────────────────────

  /**
   * 检查文件操作是否被沙箱允许。
   *
   * - 未配置 PathGuard（旧代码路径）→ 默认放行
   * - 已配置 PathGuard → 委托给 PathGuard.check()
   */
  checkFilePath(operation: FileOperation, targetPath: string): PathCheckResult {
    if (!this.pathGuard) {
      return {
        allowed: true,
        canonicalPath: path.resolve(targetPath),
        level: "FULL",
        required: "READ_ONLY",
        reason: "No sandbox configured",
      };
    }
    const result = this.pathGuard.check(operation, targetPath);
    if (!result.allowed) {
      this.sandboxService?.recordDenied(operation, targetPath, result);
    }
    return result;
  }

  /**
   * 断言文件操作被沙箱允许，否则抛出友好错误。
   *
   * 错误消息经过脱敏：不暴露内部路径信息，只给出操作类型和原因。
   */
  assertFilePath(operation: FileOperation, targetPath: string): void {
    const result = this.checkFilePath(operation, targetPath);
    if (!result.allowed) {
      throw new Error(
        `Sandbox denied ${operation} operation: ${this.sanitizeReason(result.reason)}`,
      );
    }
  }

  /**
   * 批量检查多个路径。任一拒绝即返回拒绝结果。
   */
  checkFilePaths(
    operation: FileOperation,
    paths: string[],
  ): PathCheckResult {
    if (!this.pathGuard) {
      return {
        allowed: true,
        canonicalPath: "",
        level: "FULL",
        required: "READ_ONLY",
        reason: "No sandbox configured",
      };
    }
    const result = this.pathGuard.checkAll(operation, paths);
    if (!result.allowed) {
      this.sandboxService?.recordDenied(
        operation,
        result.canonicalPath,
        result,
      );
    }
    return result;
  }

  // ── Bash 命令预检 ─────────────────────────────────────────────────

  /**
   * 检查 Bash 命令是否通过预检。
   *
   * 命中危险模式时拒绝，并写入安全审计日志。
   */
  checkBashCommand(command: string): { allowed: boolean; reason: string } {
    if (!this.pathGuard) {
      return { allowed: true, reason: "No sandbox configured" };
    }
    const result = checkBashPreflight(command);
    if (!result.allowed) {
      this.recordBashDenied(command, result.pattern);
      return { allowed: false, reason: `Dangerous command pattern detected: ${result.pattern}` };
    }
    return { allowed: true, reason: "OK" };
  }

  /** 记录扩展层产生的 bash 拒绝（例如 OS 沙箱未就绪时禁用 bash）。 */
  recordBashDenied(command: string, pattern: string): void {
    this.sandboxService?.recordPreflightDenied(command, pattern);
  }

  // ── 私有辅助 ──────────────────────────────────────────────────────

  private validateAllMode(
    cwd: string | undefined,
    confirmed: boolean | undefined,
  ): void {
    if (!confirmed) {
      throw new Error("all 模式必须先在工作区设置中确认");
    }
    if (!cwd || cwd.trim() === "") {
      throw new Error("all 模式需要指定工作目录");
    }

    const resolved = path.resolve(cwd);
    if (resolved.includes("..")) {
      throw new Error("工作目录不允许包含 .. 路径");
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`工作目录不存在: ${resolved}`);
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      throw new Error(`工作目录不可读取: ${resolved}`);
    }
  }

  /**
   * 对沙箱拒绝原因进行脱敏处理，不暴露内部绝对路径。
   */
  private sanitizeReason(reason: string): string {
    // 替换常见的绝对路径模式为脱敏占位符
    return reason
      .replace(/[A-Za-z]:\\[^\s,;]+/g, "[path]")
      .replace(/\/[^\s,;]+/g, "[path]");
  }
}
