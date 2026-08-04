import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

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
// Phase 12 MCP Runtime（plans/phase-12.md §9.1 / §12.5）
//
// - MCP Server 子进程（stdio），JSON-RPC 2.0 行帧（与 json-rpc.ts 编解码一致）；
// - 启动握手 initialize → notifications/initialized；
// - 工具调用转 MCP tools/call，超时/取消经 notifications/cancelled；
// - stdout 为协议通道，stderr 走 onOutput（StreamCapture）；
// - MCP 插件同样进入平台权限 + Trace + Activity 包装，不让配置绕过 Registry。
// ═══════════════════════════════════════════════════════════════

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpRuntimeOptions {
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  readonly versionDir: string;
  readonly entry: string;
  readonly nodePath?: string;
  /** 覆盖启动命令（如 npx 启动的 MCP Server）；缺省 node <entry> */
  readonly command?: readonly string[];
  readonly carriers: CarrierRegistry;
  readonly onExit: (info: { code: number | null; signal: string | null }) => void;
  readonly onOutput: (chunk: Buffer | string) => void;
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export class McpRuntime implements PluginRuntime {
  readonly kind = "mcp" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly launchCommand: readonly string[];
  private readonly handshakeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private child: ChildProcess | undefined;
  private client: JsonRpcClient | undefined;
  private intentionalStop = false;
  private serverCapabilities: unknown;

  constructor(private readonly options: McpRuntimeOptions) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    if (options.command !== undefined) {
      this.launchCommand = [...options.command];
    } else {
      const entryPath = path.resolve(options.versionDir, options.entry);
      if (!isPathWithinRoot(entryPath, options.versionDir)) {
        throw new Error(`MCP 入口超出版本目录：${options.entry}`);
      }
      const isScript = /\.(?:js|mjs|cjs)$/i.test(options.entry);
      this.launchCommand = isScript ? [(options.nodePath ?? process.execPath), entryPath] : [entryPath];
    }
  }

  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    const [command, ...args] = this.launchCommand;
    const child = spawn(command as string, args as string[], {
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
      child.kill("SIGKILL");
      throw new Error("MCP 子进程 stdio 不可用");
    }
    const client = new JsonRpcClient({
      transport: { stdin, stdout },
      deferConnectionFailure: true,
      onNotification: (message) => this.handleNotification(message),
    });
    this.client = client;
    try {
      const result = await client.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencolorful", version: this.version },
        },
        { timeoutMs: this.handshakeTimeoutMs },
      );
      if (typeof result !== "object" || result === null) {
        throw new Error("MCP Server initialize 响应非法");
      }
      this.serverCapabilities = (result as { capabilities?: unknown }).capabilities;
      client.notify("notifications/initialized", {});
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

  /** 列出 MCP Server 声明的工具（协议级 tools/list）。 */
  async listTools(timeoutMs = 10_000): Promise<McpToolDefinition[]> {
    if (this.client === undefined || this.state !== "running") {
      return [];
    }
    try {
      const result = (await this.client.request("tools/list", {}, { timeoutMs })) as { tools?: unknown };
      if (Array.isArray(result?.tools)) {
        return result.tools as McpToolDefinition[];
      }
      return [];
    } catch {
      return [];
    }
  }

  /** 工具调用转 MCP tools/call；method 即工具名。 */
  async invoke(input: RuntimeInvokeInput): Promise<RuntimeInvokeResult> {
    const client = this.client;
    if (client === undefined || this.state !== "running") {
      return { ok: false, code: "not-running", message: "MCP 运行实例未处于 running 状态" };
    }
    try {
      const result = (await client.request(
        "tools/call",
        {
          name: input.method,
          arguments: input.params,
        },
        {
          ...(input.carrier !== undefined ? { carrier: input.carrier } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          onCancel: (id) => {
            try {
              client.notify("notifications/cancelled", { requestId: id, reason: "cancelled" });
            } catch {
              // ignore
            }
          },
        },
      )) as { content?: unknown; isError?: boolean };
      if (result?.isError === true) {
        const text = extractText(result.content);
        return { ok: false, code: "mcp-error", message: text.slice(0, 400) || "MCP 工具调用返回错误" };
      }
      return { ok: true, result: { content: result?.content ?? [], isError: false } };
    } catch (error) {
      return this.classifyError(error);
    }
  }

  cancel(operationId: string, reason: string): void {
    try {
      this.client?.notify("notifications/cancelled", { requestId: operationId, reason });
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
        client.notify("notifications/cancelled", { requestId: null, reason });
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

/** 从 MCP content 块中提取纯文本（诊断摘要用）。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}
