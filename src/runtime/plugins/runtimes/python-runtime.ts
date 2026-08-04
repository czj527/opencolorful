import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_IPC_VERSION } from "../../../contracts/plugin-protocol.js";
import { isPathWithinRoot } from "../paths.js";
import type { CarrierRegistry } from "./carrier-registry.js";
import {
  JsonRpcClient,
  RpcCancelledError,
  RpcTimeoutError,
  RpcTransportError,
  type JsonRpcNotificationMessage,
  type JsonRpcWorkerRequest,
} from "./json-rpc.js";
import type { PluginRuntime, RuntimeInvokeInput, RuntimeInvokeResult, RuntimeStatus } from "./runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Python Process Runtime（plans/phase-12.md §9.1 / T7）
//
// - 独立 Python 子进程，stdin/stdout 承载版本化 JSON-RPC；
// - 解释器发现（plans/phase-12.md §9.1 / T7）：插件声明且校验路径/venv →
//   系统 python3 → python → 拒绝；禁止下载解释器；
// - stderr 走 onOutput（StreamCapture），不作为协议通道；
// - 崩溃/超时/取消语义与 Node Runtime 一致。
// ═══════════════════════════════════════════════════════════════

export interface PythonRuntimeOptions {
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  readonly versionDir: string;
  readonly entry: string;
  /** 插件声明且校验过的解释器（绝对路径/venv 内命令）；缺省系统发现 */
  readonly interpreter?: string;
  readonly carriers: CarrierRegistry;
  readonly onExit: (info: { code: number | null; signal: string | null }) => void;
  readonly onOutput: (chunk: Buffer | string) => void;
  /**
   * worker 主动请求（带 id）处理入口：由 RuntimeHost 注入桥接
   * （校验 carrier → 身份 → HostBroker 白名单调用）；缺省回 method-not-found。
   */
  readonly onWorkerRequest?: (message: JsonRpcWorkerRequest) => unknown;
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

export class PythonInterpreterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonInterpreterNotFoundError";
  }
}

/**
 * 解释器发现：插件声明（校验路径/命令存在）→ 系统 python3 → python。
 * 找不到即拒绝，绝不下载解释器。
 */
export function resolvePythonInterpreter(interpreter?: string): string {
  if (interpreter !== undefined && interpreter.trim() !== "") {
    const trimmed = interpreter.trim();
    if (path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
      if (!fs.existsSync(trimmed)) {
        throw new PythonInterpreterNotFoundError(`插件声明的 Python 解释器不存在：${trimmed}`);
      }
    }
    return trimmed;
  }
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; sys.exit(0)"], {
      timeout: 5_000,
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.status === 0) {
      return candidate;
    }
  }
  throw new PythonInterpreterNotFoundError("未找到可用的 Python 解释器（python3/python），且禁止自动下载");
}

export class PythonRuntime implements PluginRuntime {
  readonly kind = "python-process" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly interpreter: string;
  private readonly entryPath: string;
  private readonly handshakeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private child: ChildProcess | undefined;
  private client: JsonRpcClient | undefined;
  private intentionalStop = false;

  constructor(private readonly options: PythonRuntimeOptions) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    const entryPath = path.resolve(options.versionDir, options.entry);
    if (!isPathWithinRoot(entryPath, options.versionDir)) {
      throw new Error(`Python 入口超出版本目录：${options.entry}`);
    }
    this.entryPath = entryPath;
    this.interpreter = resolvePythonInterpreter(options.interpreter);
  }

  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    const child = spawn(this.interpreter, [this.entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.versionDir,
      windowsHide: true,
    });
    this.child = child;
    child.on("error", (error) => {
      if (!this.intentionalStop) {
        this.options.onExit({ code: null, signal: null });
      }
      void error;
    });
    child.on("exit", (code, signal) => {
      if (!this.intentionalStop) {
        this.options.onExit({ code, signal });
      }
      this.client?.failConnection(new RpcTransportError("connection-closed", "worker 已退出"));
    });
    if (child.stderr !== null) {
      child.stderr.on("data", (chunk: Buffer) => {
        this.options.onOutput(chunk);
      });
    }
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      this.intentionalStop = true;
      child.kill();
      throw new Error("Python 子进程 stdio 不可用");
    }
    const client = new JsonRpcClient({
      transport: { stdin, stdout },
      deferConnectionFailure: true,
      onNotification: (message) => this.handleNotification(message),
      // worker 主动请求：未注入 handler 时不传 onRequest（json-rpc 缺省回 method-not-found）
      ...(this.options.onWorkerRequest !== undefined ? { onRequest: this.options.onWorkerRequest } : {}),
    });
    this.client = client;
    try {
      const handshake = await client.request(
        "runtime.initialize",
        {
          pluginId: this.pluginId,
          runtimeInstanceId: this.runtimeInstanceId,
          version: this.version,
          protocolVersion: PLUGIN_IPC_VERSION,
        },
        { timeoutMs: this.handshakeTimeoutMs },
      );
      if (typeof handshake !== "object" || handshake === null || (handshake as { protocolVersion?: unknown }).protocolVersion !== PLUGIN_IPC_VERSION) {
        throw new Error(`Python worker 协议版本不匹配：${JSON.stringify(handshake)?.slice(0, 200)}`);
      }
      this.state = "running";
    } catch (error) {
      this.intentionalStop = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      const exit = await this.waitForExit(child, this.shutdownGraceMs);
      if (exit.code === null && exit.signal === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        await this.waitForExit(child, this.shutdownGraceMs);
      }
      this.client = undefined;
      throw error;
    }
  }

  async invoke(input: RuntimeInvokeInput): Promise<RuntimeInvokeResult> {
    const client = this.client;
    if (client === undefined || this.state !== "running") {
      return { ok: false, code: "not-running", message: "Python 运行实例未处于 running 状态" };
    }
    try {
      const result = await client.request(input.method, input.params, {
        ...(input.carrier !== undefined ? { carrier: input.carrier } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        onCancel: (id) => {
          try {
            client.notify("cancel", { id });
          } catch {
            // ignore
          }
        },
      });
      return { ok: true, result };
    } catch (error) {
      return this.classifyError(error);
    }
  }

  cancel(operationId: string, reason: string): void {
    try {
      this.client?.notify("cancel-operation", { operationId, reason });
    } catch {
      // ignore
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.intentionalStop) {
      return;
    }
    this.intentionalStop = true;
    this.state = "stopped";
    const child = this.child;
    const client = this.client;
    if (client !== undefined && child !== undefined) {
      try {
        client.notify("runtime.shutdown", { reason });
      } catch {
        // ignore
      }
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    if (child !== undefined) {
      let exit = await this.waitForExit(child, this.shutdownGraceMs);
      if (exit.code === null && exit.signal === null) {
        try {
          child.kill();
        } catch {
          // ignore
        }
        exit = await this.waitForExit(child, this.shutdownGraceMs);
        if (exit.code === null && exit.signal === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          await this.waitForExit(child, this.shutdownGraceMs);
        }
      }
    }
    this.detach();
  }

  isHealthy(): boolean {
    const child = this.child;
    return this.state === "running" && child !== undefined && child.exitCode === null && !child.killed;
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private handleNotification(message: JsonRpcNotificationMessage): void {
    if (message.carrier !== undefined) {
      this.options.carriers.consume(message.carrier);
    }
  }

  private classifyError(error: unknown): RuntimeInvokeResult {
    if (error instanceof RpcTimeoutError) {
      return { ok: false, code: "timeout", message: error.message.slice(0, 400) };
    }
    if (error instanceof RpcCancelledError) {
      return { ok: false, code: "cancelled", message: error.message.slice(0, 400) };
    }
    if (error instanceof RpcTransportError) {
      return { ok: false, code: error.code, message: error.message.slice(0, 400) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "internal", message: message.slice(0, 400) };
  }

  private waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: string | null }> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      let settled = false;
      const finish = (code: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        resolve({ code, signal });
      };
      const onExit = (code: number | null, signal: string | null): void => finish(code, signal);
      const onError = (): void => finish(null, null);
      const timer = setTimeout(() => finish(null, null), timeoutMs);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  private detach(): void {
    const child = this.child;
    if (child !== undefined) {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
    }
    this.child = undefined;
    this.client = undefined;
  }
}
