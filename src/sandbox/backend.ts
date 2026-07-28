import type { PathGuardPolicy } from "../contracts/sandbox.js";

/**
 * 一次命令执行的输入参数。
 */
export interface ExecuteOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

/**
 * 一次命令执行的结果。
 */
export interface ExecuteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * 沙箱后端 — 负责在受控环境中执行 Agent 命令。
 *
 * 每个后端实例绑定到一个 Agent，携带该 Agent 的路径守卫策略。
 * 不同后端可以使用不同隔离技术（本地进程、Docker、Firecracker 等）。
 */
export interface SandboxBackend {
  /** 后端唯一标识 */
  readonly id: string;

  /** 执行命令 */
  execute(options: ExecuteOptions): Promise<ExecuteResult>;

  /** 释放后端资源 */
  dispose(): Promise<void>;
}

/**
 * 沙箱后端工厂 — 为指定 Agent 创建沙箱后端实例。
 */
export interface SandboxBackendFactory {
  /** 工厂唯一标识，与 SandboxBackend.id 对应 */
  readonly id: string;

  /** 为指定 Agent 创建沙箱后端 */
  create(agentId: string, policy: PathGuardPolicy): Promise<SandboxBackend>;
}
