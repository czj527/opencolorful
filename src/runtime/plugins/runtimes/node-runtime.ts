import { spawn, type ChildProcess } from "node:child_process";
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
} from "./json-rpc.js";
import type { PluginRuntime, RuntimeInvokeInput, RuntimeInvokeResult, RuntimeStatus } from "./runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Node Process Runtime（plans/phase-12.md §9.1 / §9.2）
//
// - 独立 Node 子进程（不注入 Server 主进程），stdin/stdout 承载版本化
//   JSON-RPC（行帧、1MB 上限、超时、取消）；
// - stderr 不作为协议通道：走 onOutput（StreamCapture 脱敏/折叠/限速）；
// - 启动握手 runtime.initialize 校验协议版本，失败即启动失败；
// - 崩溃（非预期 exit / spawn error）回调 onExit 交给 RuntimeHost 判定重启；
// - stop 使用 runtime.shutdown 通知 + EOF + SIGTERM → SIGKILL 兜底，防悬挂。
// ═══════════════════════════════════════════════════════════════

export interface NodeRuntimeOptions {
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  /** 安装版本目录（绝对路径） */
  readonly versionDir: string;
  /** worker 入口（相对版本目录） */
  readonly entry: string;
  readonly nodePath?: string;
  readonly carriers: CarrierRegistry;
  readonly onExit: (info: { code: number | null; signal: string | null }) => void;
  readonly onOutput: (chunk: Buffer | string) => void;
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

export class NodeRuntime implements PluginRuntime {
  readonly kind = "node-process" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly nodePath: string;
  private readonly entryPath: string;
  private readonly handshakeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private child: ChildProcess | undefined;
  private client: JsonRpcClient | undefined;
  private intentionalStop = false;

  constructor(private readonly options: NodeRuntimeOptions) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.nodePath = options.nodePath ?? process.execPath;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    const entryPath = path.resolve(options.versionDir, options.entry);
    if (!isPathWithinRoot(entryPath, options.versionDir)) {
      throw new Error(`Node 入口超出版本目录：${options.entry}`);
    }
    this.entryPath = entryPath;
  }

  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    const child = spawn(this.nodePath, [this.entryPath], {
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
        // 先同步完成宿主侧崩溃判定（crashedAt/取消 in-flight），再拒绝剩余 pending
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
      child.kill("SIGKILL");
      throw new Error("Node 子进程 stdio 不可用");
    }
    const client = new JsonRpcClient({
      transport: { stdin, stdout },
      deferConnectionFailure: true,
      onNotification: (message) => this.handleNotification(message),
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
        throw new Error(`Node worker 协议版本不匹配：${JSON.stringify(handshake)?.slice(0, 200)}`);
      }
      this.state = "running";
    } catch (error) {
      this.intentionalStop = true;
      try {
        child.kill("SIGTERM");
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
      return { ok: false, code: "not-running", message: "Node 运行实例未处于 running 状态" };
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
            // 取消通知失败不影响本侧拒绝
          }
        },
      });
      return { ok: true, result };
    } catch (error) {
      return this.classifyError(error);
    }
  }

  /** 通知 worker 取消指定操作（最佳努力；Host 侧已通过 AbortSignal 拒绝）。 */
  cancel(operationId: string, reason: string): void {
    try {
      this.client?.notify("cancel-operation", { operationId, reason });
    } catch {
      // ignore
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.intentionalStop) {
      // 幂等
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
          child.kill("SIGTERM");
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
    // worker 回传 carrier 的通知：一次性消费校验（重复/跨实例/过期拒绝）
    if (message.carrier !== undefined) {
      this.options.carriers.consume(message.carrier);
    }
    // T5（Contribution Registry）阶段才处理领域通知；本阶段只校验 carrier 后丢弃
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
