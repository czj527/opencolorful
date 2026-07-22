import { type ChildProcess, spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import { readRuntimeState, isProcessRunning } from "../server/runtime-state.js";
import type { AgentServerStatus, SupervisorState } from "./types.js";

export interface ProcessControllerOptions {
  readonly paths: RuntimePaths;
  readonly agentServerPort: number;
  readonly supervisorPort: number;
  readonly entryScript?: string;
}

const HEALTH_TIMEOUT_MS = 15_000;

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // taskkill /T 终止进程树，/F 强制
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
      resolve();
    }
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessRunning(pid);
}

export class ProcessController {
  private child: ChildProcess | null = null;
  private startPromise: Promise<{ pid: number; port: number }> | null = null;
  private readonly paths: RuntimePaths;
  private readonly agentServerPort: number;
  private readonly supervisorPort: number;
  private readonly entryScript: string | undefined;

  constructor(options: ProcessControllerOptions) {
    this.paths = options.paths;
    this.agentServerPort = options.agentServerPort;
    this.supervisorPort = options.supervisorPort;
    this.entryScript = options.entryScript;
  }

  get agentServerRunning(): boolean {
    if (this.child !== null) {
      return this.child.exitCode === null && this.child.pid !== undefined;
    }
    const state = this.readSupervisorState();
    if (state?.agentServerPid !== null && state?.agentServerPid !== undefined) {
      return isProcessRunning(state.agentServerPid);
    }
    return false;
  }

  get agentServerPid(): number | null {
    if (this.child !== null && this.child.exitCode === null && this.child.pid !== undefined) {
      return this.child.pid;
    }
    const statePid = this.readSupervisorState()?.agentServerPid ?? null;
    if (statePid !== null && isProcessRunning(statePid)) return statePid;
    return null;
  }

  async startAgentServer(): Promise<{ pid: number; port: number }> {
    // 串行化并发 start：第二个调用等待第一个完成
    if (this.startPromise !== null) {
      return this.startPromise;
    }
    this.startPromise = this.doStartAgentServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStartAgentServer(): Promise<{ pid: number; port: number }> {
    if (this.agentServerRunning) {
      const pid = this.agentServerPid;
      if (pid !== null) {
        return { pid, port: this.agentServerPort };
      }
    }

    fs.mkdirSync(path.dirname(this.paths.serverLog), { recursive: true });
    const logHandle = fs.openSync(this.paths.serverLog, "a");

    const entry = this.entryScript ?? path.resolve(process.argv[1] ?? "");
    const childArgs = entry.endsWith(".ts")
      ? ["--import", "tsx", entry, "server", "start", "--foreground"]
      : [entry, "server", "start", "--foreground"];

    const child = spawn(process.execPath, childArgs, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logHandle, logHandle],
      env: {
        ...process.env,
        PERSON_AGENT_HOME: this.paths.home,
        PERSON_AGENT_PORT: String(this.agentServerPort),
        PERSON_AGENT_DAEMON: "1",
      },
    });
    child.unref();
    fs.closeSync(logHandle);

    this.child = child;
    const pid = child.pid;
    if (pid === undefined) {
      this.child = null;
      throw new Error("无法启动 Agent Server 子进程");
    }

    // 子进程提前退出时立即失败；退出后清理引用与状态
    let exitedEarly = false;
    child.once("exit", () => {
      exitedEarly = true;
      if (this.child === child) {
        this.child = null;
      }
      this.updateAgentServerStatus("stopped");
    });

    try {
      // 健康检查必须验证响应 PID 属于当前子进程，防止端口被其他服务占用时误判
      await this.waitForHealth(this.agentServerPort, HEALTH_TIMEOUT_MS, () => exitedEarly, pid);
    } catch (error) {
      // 启动失败：清理子进程树、状态和引用
      await killProcessTree(pid);
      await waitForExit(pid, 3_000);
      if (this.child === child) {
        this.child = null;
      }
      this.updateAgentServerStatus("error");
      throw error;
    }

    this.writeSupervisorState({
      supervisorPid: process.pid,
      supervisorPort: this.supervisorPort,
      supervisorStartedAt: this.readSupervisorState()?.supervisorStartedAt ?? new Date().toISOString(),
      agentServerPid: pid,
      agentServerPort: this.agentServerPort,
      agentServerStatus: "online",
      agentServerStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { pid, port: this.agentServerPort };
  }

  async stopAgentServer(): Promise<void> {
    const pid = this.agentServerPid;
    if (pid === null || !isProcessRunning(pid)) {
      this.child = null;
      this.updateAgentServerStatus("stopped");
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (isProcessRunning(pid)) throw error;
    }

    const exited = await waitForExit(pid, 10_000);
    if (!exited) {
      await killProcessTree(pid);
      await waitForExit(pid, 3_000);
    }

    this.child = null;
    this.updateAgentServerStatus("stopped");
  }

  async restartAgentServer(): Promise<{ pid: number; port: number }> {
    await this.stopAgentServer();
    return this.startAgentServer();
  }

  async getAgentServerStatus(): Promise<AgentServerStatus> {
    const pid = this.agentServerPid;
    if (pid === null || !isProcessRunning(pid)) {
      return "stopped";
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.agentServerPort}/api/health`,
        { signal: AbortSignal.timeout(3_000) },
      );
      return response.ok ? "online" : "degraded";
    } catch {
      return "error";
    }
  }

  readLogTail(maxBytes = 64 * 1024): { logs: string; truncated: boolean } {
    if (!fs.existsSync(this.paths.serverLog)) {
      return { logs: "", truncated: false };
    }
    const stat = fs.statSync(this.paths.serverLog);
    if (stat.size <= maxBytes) {
      return { logs: fs.readFileSync(this.paths.serverLog, "utf8"), truncated: false };
    }
    const buffer = Buffer.alloc(maxBytes);
    const fd = fs.openSync(this.paths.serverLog, "r");
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    fs.closeSync(fd);
    return { logs: `[...已截断，仅显示最后 ${Math.floor(maxBytes / 1024)}KB...]\n${buffer.toString("utf8")}`, truncated: true };
  }

  private async waitForHealth(
    port: number,
    timeoutMs: number,
    isExited: () => boolean,
    expectedPid: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isExited()) {
        throw new Error("Agent Server 子进程启动后立即退出");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { pid?: unknown };
          // 端口可能被其他服务占用并伪造健康响应，必须验证 PID 属于当前子进程
          if (body.pid === expectedPid) {
            return;
          }
        }
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Agent Server 启动超时：${timeoutMs}ms 内未响应 /api/health（或端口被占用）`);
  }

  private readSupervisorState(): SupervisorState | undefined {
    const statePath = this.supervisorStatePath;
    if (!fs.existsSync(statePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8")) as SupervisorState;
    } catch {
      return undefined;
    }
  }

  private writeSupervisorState(state: SupervisorState): void {
    const statePath = this.supervisorStatePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, statePath);
  }

  private updateAgentServerStatus(status: AgentServerStatus): void {
    const current = this.readSupervisorState();
    if (current === undefined) {
      if (status === "stopped" || status === "error") return;
      return;
    }
    this.writeSupervisorState({
      ...current,
      agentServerStatus: status,
      updatedAt: new Date().toISOString(),
    });
  }

  private get supervisorStatePath(): string {
    return path.join(this.paths.runtime, "supervisor.json");
  }
}
