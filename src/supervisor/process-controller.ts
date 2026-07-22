import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import { PLATFORM_VERSION } from "../index.js";
import { readRuntimeState, isProcessRunning } from "../server/runtime-state.js";
import type { AgentServerStatus, SupervisorState } from "./types.js";

export interface ProcessControllerOptions {
  readonly paths: RuntimePaths;
  readonly agentServerPort: number;
  readonly supervisorPort: number;
  readonly entryScript?: string;
}

export class ProcessController {
  private child: ChildProcess | null = null;
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
    if (this.child?.pid !== undefined) return this.child.pid;
    return this.readSupervisorState()?.agentServerPid ?? null;
  }

  async startAgentServer(): Promise<{ pid: number; port: number }> {
    if (this.agentServerRunning) {
      const pid = this.agentServerPid;
      if (pid !== null) {
        return { pid, port: this.agentServerPort };
      }
    }

    this.cleanupOrphanedState();

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
        PERSON_AGENT_PORT: String(this.agentServerPort),
        PERSON_AGENT_DAEMON: "1",
      },
    });
    child.unref();
    fs.closeSync(logHandle);

    this.child = child;
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("无法启动 Agent Server 子进程");
    }

    await this.waitForHealth(this.agentServerPort, 15_000);

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

    const deadline = Date.now() + 10_000;
    while (isProcessRunning(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already dead */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
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

  private async waitForHealth(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Agent Server 启动超时：${timeoutMs}ms 内未响应 /api/health`);
  }

  private cleanupOrphanedState(): void {
    const state = readRuntimeState(this.paths);
    if (state !== undefined && state.pid !== process.pid && !isProcessRunning(state.pid)) {
      // Server state is stale (orphaned PID)
    }
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
    if (current === undefined) return;
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
