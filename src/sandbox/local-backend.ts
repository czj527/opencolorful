import { exec } from "node:child_process";

import type { PathGuardPolicy } from "../contracts/sandbox.js";
import type { ExecuteOptions, ExecuteResult, SandboxBackend } from "./backend.js";
import { PathGuard } from "./path-guard.js";
import { checkBashPreflight } from "./preflight.js";

/**
 * 从命令字符串中提取绝对路径参数。
 *
 * 简单实现：提取以 `/` 或盘符（`C:\`）开头的路径 token。
 * 同时处理双引号和单引号包裹的路径。
 */
function extractPaths(command: string): string[] {
  const paths: string[] = [];

  // 双引号路径
  for (const m of command.matchAll(/"([^"]+)"/g)) {
    const p = m[1]!;
    if (p.startsWith("/") || /^[A-Za-z]:\\/.test(p)) {
      paths.push(p);
    }
  }

  // 单引号路径
  for (const m of command.matchAll(/'([^']+)'/g)) {
    const p = m[1]!;
    if (p.startsWith("/") || /^[A-Za-z]:\\/.test(p)) {
      paths.push(p);
    }
  }

  // 未加引号的绝对路径 token
  for (const m of command.matchAll(/(?<!\S)((?:[A-Za-z]:\\|\/)[^\s'"<>|]+)/g)) {
    paths.push(m[1]!);
  }

  // 去重
  return [...new Set(paths)];
}

/**
 * LocalBackend — 在本地操作系统的子进程中执行 Agent 命令。
 *
 * 执行流程：
 * 1. bash preflight 检查（拦截危险命令模式）
 * 2. 从命令字符串中提取绝对路径参数
 * 3. 逐路径 PathGuard.check("exec", path) 检查
 * 4. 全部通过后通过 child_process.exec 启动子进程执行
 * 5. 超时后自动 kill 进程树
 */
export class LocalBackend implements SandboxBackend {
  readonly id = "local" as const;

  private readonly pathGuard: PathGuard;

  constructor(
    private readonly agentId: string,
    policy: PathGuardPolicy,
  ) {
    this.pathGuard = new PathGuard(policy);
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    // 1. preflight 检查
    const preflight = checkBashPreflight(options.command);
    if (!preflight.allowed) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `Sandbox preflight denied: command matches dangerous pattern "${preflight.pattern}"`,
        timedOut: false,
      };
    }

    // 2. 提取路径参数并检查
    const paths = extractPaths(options.command);
    if (paths.length > 0) {
      const pathResult = this.pathGuard.checkAll("exec", paths);
      if (!pathResult.allowed) {
        return {
          exitCode: 126,
          stdout: "",
          stderr: `Sandbox path denied: ${pathResult.reason}`,
          timedOut: false,
        };
      }
    }

    // 3. 执行子进程
    return new Promise<ExecuteResult>((resolve) => {
      const child = exec(
        options.command,
        {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs ?? 30000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              exitCode: error.code ?? 1,
              stdout,
              stderr,
              timedOut: (error as unknown as { killed?: boolean }).killed === true,
            });
          } else {
            resolve({
              exitCode: 0,
              stdout,
              stderr,
              timedOut: false,
            });
          }
        },
      );
    });
  }

  async dispose(): Promise<void> {
    // no-op: local backend has no persistent resources to release
  }
}
