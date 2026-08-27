import { type ChildProcess, spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import { readRuntimeState, isProcessRunning } from "../server/runtime-state.js";
import { filterLogLines, type LogQuery, type LogTail } from "./log-filter.js";
import type { AgentServerStatus, SupervisorState, WatchdogStatus } from "./types.js";
import { instrument } from "../observability/instrument.js";

export interface ProcessControllerOptions {
  readonly paths: RuntimePaths;
  readonly agentServerPort: number;
  readonly supervisorPort: number;
  readonly entryScript?: string;
  readonly autoRestartEnabled?: boolean;
  readonly autoRestartMaxFailures?: number;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartStabilityMs?: number;
  readonly watchdogIntervalMs?: number;
}

const DEFAULT_AUTO_RESTART_ENABLED = true;
const DEFAULT_AUTO_RESTART_MAX_FAILURES = 5;
const DEFAULT_AUTO_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_AUTO_RESTART_MAX_DELAY_MS = 30_000;
const DEFAULT_AUTO_RESTART_STABILITY_MS = 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;
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
  private lifecycleStatus: AgentServerStatus = "stopped";
  /** 正在主动停止的子进程，用于在 exit 事件异步触发时区分"主动 stop"与"意外退出" */
  private stoppingChild: ChildProcess | null = null;
  private readonly paths: RuntimePaths;
  private readonly agentServerPort: number;
  private readonly supervisorPort: number;
  private readonly entryScript: string | undefined;

  // 看门狗：期望状态与自动重启退避
  private readonly autoRestartEnabled: boolean;
  private readonly autoRestartMaxFailures: number;
  private readonly autoRestartBaseDelayMs: number;
  private readonly autoRestartMaxDelayMs: number;
  private readonly autoRestartStabilityMs: number;
  private readonly watchdogIntervalMs: number;
  private desiredRunning: boolean = false;
  private consecutiveFailures: number = 0;
  private autoRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRestartAt: number | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProcessControllerOptions) {
    this.paths = options.paths;
    this.agentServerPort = options.agentServerPort;
    this.supervisorPort = options.supervisorPort;
    this.entryScript = options.entryScript;
    this.autoRestartEnabled = options.autoRestartEnabled ?? DEFAULT_AUTO_RESTART_ENABLED;
    this.autoRestartMaxFailures = options.autoRestartMaxFailures ?? DEFAULT_AUTO_RESTART_MAX_FAILURES;
    this.autoRestartBaseDelayMs = options.autoRestartBaseDelayMs ?? DEFAULT_AUTO_RESTART_BASE_DELAY_MS;
    this.autoRestartMaxDelayMs = options.autoRestartMaxDelayMs ?? DEFAULT_AUTO_RESTART_MAX_DELAY_MS;
    this.autoRestartStabilityMs = options.autoRestartStabilityMs ?? DEFAULT_AUTO_RESTART_STABILITY_MS;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    // 跨 supervisor 重启收养期望运行态：若 supervisor.json 中记录 agent server 在线/降级且 pid 仍存活，
    // 新 controller 应将其视为期望运行，看门狗慢路径轮询兜底其死亡。
    this.desiredRunning = this.inferDesiredRunningFromState();
    if (this.desiredRunning) {
      this.startStabilityWindow();
    }
    this.startWatchdogPolling();
  }

  private inferDesiredRunningFromState(): boolean {
    const state = this.readSupervisorState();
    if (state === undefined || state.agentServerPid === null) return false;
    const status = state.agentServerStatus;
    if (status !== "online" && status !== "degraded") return false;
    return isProcessRunning(state.agentServerPid);
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
    // 手动触发启动时，取消看门狗已排队的退避定时器，避免冗余重试
    this.clearAutoRestartTimer();
    this.startPromise = this.doStartAgentServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStartAgentServer(): Promise<{ pid: number; port: number }> {
    if (this.agentServerRunning) {
      this.lifecycleStatus = "online";
      const pid = this.agentServerPid;
      if (pid !== null) {
        return { pid, port: this.agentServerPort };
      }
    }

    this.lifecycleStatus = "starting";

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
        OPENCOLORFUL_HOME: this.paths.home,
        OPENCOLORFUL_PORT: String(this.agentServerPort),
        OPENCOLORFUL_DAEMON: "1",
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

    // 子进程退出处理器：主动 stop 时 stoppingChild/lifecycleStatus 已标记；
    // 意外退出且期望运行中则触发看门狗自动重起。
    let exitedEarly = false;
    child.once("exit", () => {
      exitedEarly = true;
      if (this.child === child) {
        this.child = null;
      }
      const wasStopping = this.lifecycleStatus === "stopping" || this.stoppingChild === child;
      this.lifecycleStatus = wasStopping ? "stopped" : "error";
      if (wasStopping) {
        this.updateAgentServerStatus("stopped");
        return;
      }
      // 意外退出（非主动 stop）→ health degraded，并由看门狗在期望运行时排期重试
      instrument.healthDegraded("Agent Server 进程意外退出");
      instrument.error("supervisor.agent_server.exited", "Agent Server 进程意外退出");
      if (this.desiredRunning) {
        this.handleUnexpectedExit();
      } else {
        this.updateAgentServerStatus("error");
      }
    });

    try {
      // 健康检查必须验证响应 PID 属于当前子进程，防止端口被其他服务占用时误判
      await this.waitForHealth(this.agentServerPort, HEALTH_TIMEOUT_MS, () => exitedEarly, pid);
    } catch (error) {
      // 启动失败：清理子进程树、状态和引用；子进程退出事件处理器会在期望运行中
      // 时继续退避，此处不再重复计数，避免一次失败被 double-count。
      await killProcessTree(pid);
      await waitForExit(pid, 3_000);
      if (this.child === child) {
        this.child = null;
      }
      // 启动期间被显式 stop 竞态打断（T11 自动拉起后更易触达：如 Ctrl+C 立即退出）
      // 时保留 stopped 语义，不得覆盖为 error——否则快速 start→stop 会让状态误报 error。
      // exit 处理器对 lifecycleStatus 的赋值对控制流分析不可见，TS 会把这里窄化为
      // "starting"，因此用显式转换读取真实状态再比较。
      const statusAtFailure = this.lifecycleStatus as AgentServerStatus;
      if (statusAtFailure === "stopping" || statusAtFailure === "stopped" || this.stoppingChild === child) {
        this.lifecycleStatus = "stopped";
        this.updateAgentServerStatus("stopped");
        throw error;
      }
      this.lifecycleStatus = "error";
      instrument.healthDegraded(error instanceof Error ? error : String(error));
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
    this.lifecycleStatus = "online";
    this.desiredRunning = true;
    this.startStabilityWindow();
    instrument.healthRecovered({ attributes: { agentServerPort: this.agentServerPort } });

    return { pid, port: this.agentServerPort };
  }

  async stopAgentServer(): Promise<void> {
    // 主动 stop：取消期望运行态与所有看门狗定时器，防止与自动重启竞态
    this.desiredRunning = false;
    this.clearAutoRestartTimer();
    this.clearStabilityTimer();

    const pid = this.agentServerPid;
    const child = this.child;
    if (child !== null) {
      this.stoppingChild = child;
    }
    if (pid === null || !isProcessRunning(pid)) {
      this.child = null;
      this.stoppingChild = null;
      this.lifecycleStatus = "stopped";
      this.updateAgentServerStatus("stopped");
      return;
    }

    this.lifecycleStatus = "stopping";

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (isProcessRunning(pid)) throw error;
    }

    // Windows 上进程终止与 'exit' 事件存在异步窗口，isProcessRunning 可能先返回 false。
    // 直接等待子进程 'exit' 事件，确保 exit 处理器在 stoppingChild 仍标记时完成，
    // 避免被误判为意外退出。
    if (child !== null) {
      const exited = await new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        await killProcessTree(pid);
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 3_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } else {
      const exited = await waitForExit(pid, 10_000);
      if (!exited) {
        await killProcessTree(pid);
        await waitForExit(pid, 3_000);
      }
    }

    this.child = null;
    this.stoppingChild = null;
    this.lifecycleStatus = "stopped";
    this.updateAgentServerStatus("stopped");
  }

  async restartAgentServer(): Promise<{ pid: number; port: number }> {
    await this.stopAgentServer();
    return this.startAgentServer();
  }

  async getAgentServerStatus(): Promise<AgentServerStatus> {
    if (this.lifecycleStatus === "starting" || this.lifecycleStatus === "stopping") {
      return this.lifecycleStatus;
    }
    const pid = this.agentServerPid;
    if (pid === null || !isProcessRunning(pid)) {
      return this.lifecycleStatus === "error" ? "error" : "stopped";
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.agentServerPort}/api/health`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!response.ok) return "degraded";
      const body = (await response.json()) as { pid?: unknown };
      return body.pid === pid ? "online" : "error";
    } catch {
      // 子进程仍在运行但健康端点短暂不可达时可恢复，不能把瞬时网络/启动抖动
      // 误报成不可恢复的错误；PID 不匹配仍在上方明确返回 error。
      return "degraded";
    }
  }

  /**
   * 看门狗当前状态，用于 Supervisor status 接口透传。
   * 注意：处于退避等待期时 getAgentServerStatus 仍返回 error，语义不变。
   */
  getWatchdogStatus(): WatchdogStatus {
    return {
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.autoRestartAt !== null ? new Date(this.autoRestartAt).toISOString() : null,
    };
  }

  /**
   * 子进程意外退出或被收养进程死亡时的统一处理：
   * 递增连续失败计数、置 error 态，并在期望运行时按退避策略排期自动重启。
   */
  private handleUnexpectedExit(): void {
    this.clearStabilityTimer();
    this.consecutiveFailures += 1;
    this.updateAgentServerStatus("error");
    this.scheduleAutoRestart();
  }

  /**
   * 看门狗慢路径兜底：周期性检查期望运行中的进程是否仍在运行。
   * 覆盖"收养的进程死亡无 exit 事件可挂"的场景。
   */
  private startWatchdogPolling(): void {
    this.watchdogTimer = setInterval(() => {
      if (!this.desiredRunning || this.autoRestartTimer !== null || this.startPromise !== null) {
        return;
      }
      const pid = this.agentServerPid;
      if (pid === null || !isProcessRunning(pid)) {
        this.handleUnexpectedExit();
      }
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref();
  }

  /**
   * 自动重启退避调度。只有一个挂起的退避定时器；触发前复查 desiredRunning，
   * 避免与并发 stop 竞态。达到上限后放弃并记录错误。
   */
  private scheduleAutoRestart(): void {
    if (!this.autoRestartEnabled || !this.desiredRunning) {
      return;
    }
    if (this.autoRestartTimer !== null) {
      return;
    }
    if (this.consecutiveFailures > this.autoRestartMaxFailures) {
      instrument.error(
        "supervisor.agent_server.auto_restart_exhausted",
        "Agent Server 自动重启已达上限",
        { consecutiveFailures: this.consecutiveFailures, maxFailures: this.autoRestartMaxFailures },
      );
      this.autoRestartAt = null;
      return;
    }
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const delay = Math.min(
      this.autoRestartBaseDelayMs * (2 ** exponent),
      this.autoRestartMaxDelayMs,
    );
    this.autoRestartAt = Date.now() + delay;
    this.autoRestartTimer = setTimeout(() => {
      this.autoRestartTimer = null;
      this.autoRestartAt = null;
      if (!this.desiredRunning) {
        return;
      }
      this.startAgentServer().catch(() => {
        // 失败路径在 doStartAgentServer 中已更新计数并继续排期；
        // 此处捕获仅避免 UnhandledPromiseRejection。
      });
    }, delay);
    this.autoRestartTimer.unref();
  }

  /** 启动成功后开启稳定窗口，窗口期满仍在线则归零连续失败计数。 */
  private startStabilityWindow(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.consecutiveFailures = 0;
    }, this.autoRestartStabilityMs);
    this.stabilityTimer.unref();
  }

  private clearAutoRestartTimer(): void {
    if (this.autoRestartTimer !== null) {
      clearTimeout(this.autoRestartTimer);
      this.autoRestartTimer = null;
    }
    this.autoRestartAt = null;
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  /**
   * 读取日志尾部并应用可选过滤查询。
   *
   * - 旧签名 `readLogTail(maxBytes?)` 保留兼容；传数字时返回原始尾部文本，
   *   不做 level/cursor 过滤（与 Supervisor 路由的脱敏配合使用）。
   * - 新签名 `readLogTail(query?)` 用 `LogQuery` 做 limit/since/level/query 过滤，
   *   并在 `LogTail.nextCursor` 中返回稳定的字节偏移 cursor 供增量读取。
   */
  readLogTail(queryOrMaxBytes?: number | LogQuery): LogTail | { logs: string; truncated: boolean } {
    if (typeof queryOrMaxBytes === "number") {
      const maxBytes = queryOrMaxBytes;
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
      return {
        logs: `[...已截断，仅显示最后 ${Math.floor(maxBytes / 1024)}KB...]\n${buffer.toString("utf8")}`,
        truncated: true,
      };
    }

    // query 路径：读取文件尾部用于过滤，并传递 chunk 在文件中的起始偏移
    // 使得 filterLogLines 生成的 cursor 为绝对文件偏移，跨 chunk 增量读取不会漏行。
    const MAX_BYTES = 1 * 1024 * 1024; // 1MB
    if (!fs.existsSync(this.paths.serverLog)) {
      return { logs: "", truncated: false, nextCursor: null };
    }
    const stat = fs.statSync(this.paths.serverLog);
    let raw: string;
    let chunkStart = 0;
    if (stat.size <= MAX_BYTES) {
      raw = fs.readFileSync(this.paths.serverLog, "utf8");
      chunkStart = 0;
    } else {
      chunkStart = stat.size - MAX_BYTES;
      const buffer = Buffer.alloc(MAX_BYTES);
      const fd = fs.openSync(this.paths.serverLog, "r");
      fs.readSync(fd, buffer, 0, MAX_BYTES, chunkStart);
      fs.closeSync(fd);
      // 在字节层丢弃可能不完整的首行，避免多字节字符让绝对偏移漂移。
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline >= 0) {
        raw = buffer.subarray(firstNewline + 1).toString("utf8");
        chunkStart += firstNewline + 1;
      } else {
        raw = buffer.toString("utf8");
      }
    }

    const query = queryOrMaxBytes ?? {};
    const since = query.since ?? null;
    const result = filterLogLines(raw, query, since, chunkStart);
    return {
      ...result,
      truncated: result.truncated || chunkStart > 0,
    };
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
