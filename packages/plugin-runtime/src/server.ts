// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 worker 侧 Runtime SDK（plans/phase-12.md §9.2 / §19.1）
//
// 与 T4 node-runtime 的 JSON-RPC/stdio 协议配对：
// - Host（NodeRuntime）→ worker 请求：runtime.initialize 握手 + 工具方法调用；
// - Host → worker 通知：cancel / cancel-operation / runtime.shutdown；
// - worker → Host 通知（可携带一次性 carrier）：Host Broker 白名单 API /
//   自定义 Activity；worker 不能自报平台权威字段；
// - 行分隔（`\n`）单帧 1MB；worker 不把 stdout/stderr 当协议通道；
// - 本包不 import Server 内部实现（import boundary 由
//   scripts/verify-plugin-imports.mjs 强制）。
// ═══════════════════════════════════════════════════════════════

import {
  PLUGIN_IPC_VERSION,
  type PluginIpcCarrier,
  type PluginRpcRequest,
  type PluginRpcResponse,
} from "@opencolorful/plugin-protocol";

export const WORKER_PROTOCOL_VERSION = PLUGIN_IPC_VERSION;
export const WORKER_MAX_FRAME_BYTES = 1_048_576;
export const WORKER_DEFAULT_METHOD_TIMEOUT_MS = 30_000;

export class PluginRuntimeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "PluginRuntimeError";
    this.code = code;
  }
}

/** worker 方法 handler 收到的调用上下文（平台注入；worker 不能自报权威字段）。 */
export interface WorkerHandlerContext {
  /** 取消信号：Host 发来 cancel / cancel-operation 时 abort */
  readonly signal: AbortSignal;
  /** Host 签发的一次性 carrier（回传时由 Host 单次消费） */
  readonly carrier?: PluginIpcCarrier;
  /** 平台签发的操作 id（对应 Host 侧 operationId） */
  readonly operationId?: string;
}

export type WorkerMethodHandler = (params: unknown, ctx: WorkerHandlerContext) => unknown | Promise<unknown>;

export interface PluginRuntimeServerOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly protocolVersion?: number;
  readonly maxFrameBytes?: number;
  /** 收到 runtime.shutdown 通知时回调（缺省退出进程） */
  readonly onShutdown?: (reason: string) => void;
  /** 收到 cancel-operation 通知时回调（缺省 abort 对应操作） */
  readonly onCancelOperation?: (operationId: string, reason: string) => void;
}

export interface RuntimeInitializeInfo {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  readonly version: string;
  readonly protocolVersion: number;
}

interface InFlightOperation {
  readonly operationId: string | undefined;
  readonly requestId: number | string | undefined;
  readonly controller: AbortController;
}

export class PluginRuntimeServer {
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly protocolVersion: number;
  private readonly maxFrameBytes: number;
  private readonly handlers = new Map<string, WorkerMethodHandler>();
  private readonly operations = new Map<number | string, InFlightOperation>();
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private readyResolvers: Array<(info: RuntimeInitializeInfo) => void> = [];
  private shutdownCallback: PluginRuntimeServerOptions["onShutdown"];
  private cancelOperationCallback: PluginRuntimeServerOptions["onCancelOperation"];
  private initializedInfo: RuntimeInitializeInfo | undefined;

  constructor(options: PluginRuntimeServerOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.protocolVersion = options.protocolVersion ?? WORKER_PROTOCOL_VERSION;
    this.maxFrameBytes = options.maxFrameBytes ?? WORKER_MAX_FRAME_BYTES;
    this.shutdownCallback = options.onShutdown;
    this.cancelOperationCallback = options.onCancelOperation;
    this.registerMethod("runtime.initialize", (params) => {
      const info = this.normalizeInitializeInfo(params);
      this.initializedInfo = info;
      this.handshakeDone = true;
      for (const resolve of this.readyResolvers.splice(0)) {
        resolve(info);
      }
      return { protocolVersion: this.protocolVersion };
    });
    this.stdin.on("data", (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")));
  }

  /** 注册领域方法（工具/命令 handler 等）。 */
  registerMethod(method: string, handler: WorkerMethodHandler): void {
    if (this.handlers.has(method)) {
      throw new PluginRuntimeError(-32600, `方法重复注册：${method}`);
    }
    this.handlers.set(method, handler);
  }

  /**
   * 启动并等待 Host 握手（runtime.initialize）。握手成功后返回 Host
   * 注入的运行时信息；握手超时可提供 timeoutMs（缺省 30s）。
   */
  start(timeoutMs = WORKER_DEFAULT_METHOD_TIMEOUT_MS): Promise<RuntimeInitializeInfo> {
    if (this.initializedInfo !== undefined) {
      return Promise.resolve(this.initializedInfo);
    }
    return new Promise<RuntimeInitializeInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new PluginRuntimeError(-32603, `runtime.initialize 握手超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.readyResolvers.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /** worker → Host 通知（无 id；可携带一次性 carrier，Host 单次消费）。 */
  sendNotification(method: string, params?: unknown, carrier?: PluginIpcCarrier): void {
    this.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
        ...(carrier !== undefined ? { carrier } : {}),
      }),
    );
  }

  /** worker → Host 请求（本阶段 Host 对 worker 主动请求返回 method-not-found）。 */
  request(method: string, params?: unknown, carrier?: PluginIpcCarrier): void {
    const id = `w-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const message: PluginRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(carrier !== undefined ? { carrier } : {}),
    };
    this.writeLine(JSON.stringify(message));
  }

  /** 关闭读取（进程退出前调用；幂等）。 */
  close(): void {
    try {
      this.stdin.removeAllListeners("data");
    } catch {
      // ignore
    }
  }

  /** 当前已注册方法名列表（诊断）。 */
  listMethods(): readonly string[] {
    return [...this.handlers.keys()];
  }

  // ── 内部：行帧读取与分发 ─────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.buffer = Buffer.alloc(0);
          this.writeError(-32700, `收到超过 ${this.maxFrameBytes} 字节的无换行帧，已丢弃`);
        }
        break;
      }
      if (newline > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.writeError(-32700, `收到超过 ${this.maxFrameBytes} 字节的帧，已拒绝`);
        continue;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.trim() === "") {
        continue;
      }
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.writeError(-32700, "解析错误：非法 JSON 帧");
      return;
    }
    if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      this.writeError(-32600, "非法请求：jsonrpc 必须为 2.0");
      return;
    }
    const record = message as { id?: unknown; method?: unknown; params?: unknown; carrier?: unknown };
    if (typeof record.method !== "string") {
      this.writeError(-32600, "非法请求：缺少 method");
      return;
    }
    const hasId = record.id !== undefined;
    if (hasId) {
      void this.handleRequest(record as PluginRpcRequest);
      return;
    }
    this.handleNotification(record as { method: string; params?: unknown });
  }

  private async handleRequest(message: PluginRpcRequest): Promise<void> {
    const method = message.method;
    const operationId =
      typeof message.carrier === "object" && message.carrier !== null
        ? (message.carrier as PluginIpcCarrier).operationId
        : undefined;
    const controller = new AbortController();
    this.operations.set(message.id, {
      operationId,
      requestId: message.id,
      controller,
    });
    try {
      const result = await Promise.resolve(
        this.dispatch(method, message.params, {
          signal: controller.signal,
          ...(operationId !== undefined ? { operationId } : {}),
          ...(message.carrier !== undefined ? { carrier: message.carrier } : {}),
        }),
      );
      if (controller.signal.aborted) {
        this.writeResponse(message.id, undefined, new PluginRuntimeError(-32800, "操作已取消"));
        return;
      }
      this.writeResponse(message.id, result, undefined);
    } catch (error) {
      this.writeResponse(message.id, undefined, this.toRpcError(error));
    } finally {
      this.operations.delete(message.id);
    }
  }

  private async dispatch(method: string, params: unknown, ctx: WorkerHandlerContext): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw new PluginRuntimeError(-32601, `方法未注册：${method}`);
    }
    return handler(params, ctx);
  }

  private handleNotification(message: { method: string; params?: unknown }): void {
    const method = message.method;
    const params = message.params as Record<string, unknown> | undefined;
    if (method === "cancel-operation") {
      const operationId = typeof params?.["operationId"] === "string" ? params["operationId"] : "";
      const reason = typeof params?.["reason"] === "string" ? params["reason"] : "user-abort";
      this.cancelOperation(operationId, reason);
      return;
    }
    if (method === "cancel") {
      const id = params?.["id"];
      if (typeof id === "number" || typeof id === "string") {
        this.abortById(id, "user-abort");
      }
      return;
    }
    if (method === "runtime.shutdown") {
      const reason = typeof params?.["reason"] === "string" ? params["reason"] : "shutdown";
      this.close();
      if (this.shutdownCallback !== undefined) {
        this.shutdownCallback(reason);
      } else {
        process.exit(0);
      }
      return;
    }
    // 未知通知：忽略（协议可扩展）
  }

  private cancelOperation(operationId: string, reason: string): void {
    for (const operation of this.operations.values()) {
      if (operation.operationId === operationId) {
        operation.controller.abort(new PluginRuntimeError(-32800, `操作被取消：${reason}`));
      }
    }
    if (this.cancelOperationCallback !== undefined && operationId !== "") {
      this.cancelOperationCallback(operationId, reason);
    }
  }

  private abortById(id: number | string, reason: string): void {
    const operation = this.operations.get(id);
    if (operation !== undefined) {
      operation.controller.abort(new PluginRuntimeError(-32800, `请求被取消：${reason}`));
    }
  }

  // ── 输出 ─────────────────────────────────────────────────────

  private writeResponse(id: number | string, result: unknown | undefined, error: PluginRuntimeError | undefined): void {
    const response: PluginRpcResponse = {
      jsonrpc: "2.0",
      id,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error: { code: error.code, message: error.message.slice(0, 512) } } : {}),
    };
    this.writeLine(JSON.stringify(response));
  }

  private writeError(code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
  }

  private writeLine(line: string): void {
    if (this.stdout.writable === false) {
      throw new PluginRuntimeError(-32603, "stdout 不可写");
    }
    const frame = Buffer.from(line, "utf8");
    if (frame.byteLength > this.maxFrameBytes) {
      throw new PluginRuntimeError(-32603, `发送帧超过 ${this.maxFrameBytes} 字节上限`);
    }
    this.stdout.write(Buffer.concat([frame, Buffer.from("\n", "utf8")]));
  }

  private normalizeInitializeInfo(params: unknown): RuntimeInitializeInfo {
    if (typeof params !== "object" || params === null) {
      throw new PluginRuntimeError(-32602, "runtime.initialize 缺少参数");
    }
    const record = params as Record<string, unknown>;
    const pluginId = typeof record["pluginId"] === "string" ? record["pluginId"] : "";
    const runtimeInstanceId = typeof record["runtimeInstanceId"] === "string" ? record["runtimeInstanceId"] : "";
    const version = typeof record["version"] === "string" ? record["version"] : "";
    const protocolVersion = typeof record["protocolVersion"] === "number" ? record["protocolVersion"] : 0;
    if (pluginId === "" || runtimeInstanceId === "" || version === "") {
      throw new PluginRuntimeError(-32602, "runtime.initialize 参数不完整");
    }
    return { pluginId, runtimeInstanceId, version, protocolVersion };
  }

  private toRpcError(error: unknown): PluginRuntimeError {
    if (error instanceof PluginRuntimeError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new PluginRuntimeError(-32603, message.slice(0, 512));
  }
}

/** 便捷工厂：worker 入口一行启动。 */
export function createRuntimeServer(options: PluginRuntimeServerOptions = {}): PluginRuntimeServer {
  return new PluginRuntimeServer(options);
}
