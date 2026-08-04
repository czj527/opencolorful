import type { PluginIpcCarrier, PluginRpcRequest, PluginRpcResponse } from "../../../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 版本化 JSON-RPC/stdio（plans/phase-12.md §9.2）
//
// - JSON-RPC 2.0、行分隔（单帧单行，`\n` 结尾）；JSON 序列化不产生裸换行，
//   因此按行分帧安全；
// - 帧大小上限 1MB：超限帧/超限行拒绝，不进入业务解析；
// - 请求超时默认 30s，可逐请求覆盖；超时/取消经 AbortSignal 拒绝并
//   可选向 worker 发送 cancel 通知；
// - worker 回传的权威字段一律不可信：本客户端只按 JSON-RPC id 匹配响应，
//   携带 carrier 的通知交给上层（CarrierRegistry 单次消费校验）。
// ═══════════════════════════════════════════════════════════════

export const JSON_RPC_DEFAULTS = {
  maxFrameBytes: 1_048_576, // 1MB
  defaultTimeoutMs: 30_000,
} as const;

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type RpcFailureCode = "timeout" | "cancelled" | "connection-closed" | "oversize-frame" | "parse-error" | "protocol-error" | "internal";

export class RpcTransportError extends Error {
  readonly code: RpcFailureCode;
  constructor(code: RpcFailureCode, message: string) {
    super(message);
    this.name = "RpcTransportError";
    this.code = code;
  }
}

export class RpcTimeoutError extends RpcTransportError {
  constructor(message = "JSON-RPC 请求超时") {
    super("timeout", message);
    this.name = "RpcTimeoutError";
  }
}

export class RpcCancelledError extends RpcTransportError {
  constructor(message = "JSON-RPC 请求已取消") {
    super("cancelled", message);
    this.name = "RpcCancelledError";
  }
}

/** worker 主动请求处理失败：onRequest 抛此错时按 code 映射为 JSON-RPC error 响应。 */
export class RpcRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcRequestError";
    this.code = code;
  }
}

export interface JsonRpcTransport {
  /** 平台 → worker 写入通道（child.stdin） */
  readonly stdin: NodeJS.WritableStream;
  /** worker → 平台读取通道（child.stdout） */
  readonly stdout: NodeJS.ReadableStream;
}

export interface JsonRpcNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
  readonly carrier?: PluginIpcCarrier;
}

/** worker → host 主动请求（带 id）；carrier 由平台签发，上层做身份认证与单次消费。 */
export interface JsonRpcWorkerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
  readonly carrier?: PluginIpcCarrier;
}

export interface JsonRpcClientOptions {
  readonly transport: JsonRpcTransport;
  readonly maxFrameBytes?: number;
  readonly defaultTimeoutMs?: number;
  /** 收到 worker 通知（无 id 消息）时回调（如携带 carrier，由上层做一次性消费）。 */
  readonly onNotification?: (message: JsonRpcNotificationMessage) => void;
  /**
   * 收到 worker 主动请求（带 id 的请求消息）时回调；返回结果（或 Promise）回写
   * result 响应，抛 RpcRequestError 时按 code 回写 error 响应（其他错误按
   * internal-error）；未注入时缺省回 method-not-found（向后兼容）。
   */
  readonly onRequest?: (message: JsonRpcWorkerRequest) => unknown;
  /**
   * 延迟连接失败拒绝：stdout 结束时先不拒绝 pending，而是等待运行时在
   * 子进程 exit 事件中先完成崩溃判定（onExit）再 failConnection。
   * 解决"stdout close 先于 child exit"平台时序导致 crash 终态不稳定的问题。
   */
  readonly deferConnectionFailure?: boolean;
}

export interface JsonRpcRequestOptions {
  readonly carrier?: PluginIpcCarrier;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 超时/取消时向 worker 发送的 cancel 通知（用于 MCP/自研协议终止远端工作）。 */
  readonly onCancel?: (requestId: number | string) => void;
}

interface PendingRequest {
  readonly id: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class JsonRpcClient {
  private readonly maxFrameBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly onNotification: ((message: JsonRpcNotificationMessage) => void) | undefined;
  private readonly onRequest: JsonRpcClientOptions["onRequest"];
  private readonly pending = new Map<number | string, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private connectionLost = false;
  private errorHandler: ((error: Error) => void) | undefined;

  constructor(private readonly deps: JsonRpcClientOptions) {
    this.maxFrameBytes = deps.maxFrameBytes ?? JSON_RPC_DEFAULTS.maxFrameBytes;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? JSON_RPC_DEFAULTS.defaultTimeoutMs;
    this.onNotification = deps.onNotification;
    this.onRequest = deps.onRequest;
    const onStreamEnd = (): void => {
      if (deps.deferConnectionFailure === true) {
        // 等待运行时在子进程 exit 中完成崩溃判定后调用 failConnection
        this.connectionLost = true;
        return;
      }
      this.failAll(new RpcTransportError("connection-closed", "worker stdout 已结束"));
    };
    deps.transport.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    deps.transport.stdout.on("error", (error: Error) => this.failAll(new RpcTransportError("connection-closed", `stdout 错误：${error.message}`)));
    deps.transport.stdout.on("end", onStreamEnd);
    deps.transport.stdout.on("close", onStreamEnd);
    deps.transport.stdin.on("error", (error: Error) => this.failAll(new RpcTransportError("connection-closed", `stdin 错误：${error.message}`)));
  }

  /** 运行时在子进程 exit 后调用：拒绝剩余 pending（崩溃路径先经 onExit 判定）。 */
  failConnection(error: Error): void {
    this.connectionLost = true;
    this.failAll(error);
  }

  /** 发送请求并等待响应。 */
  request(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.closed || this.connectionLost) {
      return Promise.reject(new RpcTransportError("connection-closed", "连接已关闭，无法发送请求"));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: PluginRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(options.carrier !== undefined ? { carrier: options.carrier } : {}),
    };

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        if (options.signal !== undefined) {
          options.signal.removeEventListener("abort", onAbort);
        }
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const onAbort = (): void => {
        cleanup();
        if (options.onCancel !== undefined) {
          try {
            options.onCancel(id);
          } catch {
            // cancel 通知失败不影响本侧拒绝
          }
        }
        reject(new RpcCancelledError());
      };
      const timer = setTimeout(() => {
        cleanup();
        if (options.onCancel !== undefined) {
          try {
            options.onCancel(id);
          } catch {
            // ignore
          }
        }
        reject(new RpcTimeoutError(`JSON-RPC 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new RpcCancelledError());
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const pendingEntry: PendingRequest = { id, resolve, reject, timer, cleanup };
      this.pending.set(id, pendingEntry);
      try {
        this.writeLine(JSON.stringify(message));
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  /** 发送通知（无 id，不期望响应）。 */
  notify(method: string, params?: unknown, carrier?: PluginIpcCarrier): void {
    if (this.closed) {
      throw new RpcTransportError("connection-closed", "连接已关闭，无法发送通知");
    }
    const message: JsonRpcNotificationMessage = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
      ...(carrier !== undefined ? { carrier } : {}),
    };
    this.writeLine(JSON.stringify(message));
  }

  /** 关闭连接：结束 stdin，拒绝全部 pending。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.deps.transport.stdin.end();
    } catch {
      // ignore
    }
    this.failAll(new RpcTransportError("connection-closed", "连接已关闭"));
  }

  isOpen(): boolean {
    return !this.closed;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  /** 注入 stdout 'error' 事件兜底（进程级错误监听可能被运行时重复挂载）。 */
  setErrorHandler(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) {
        // 无换行：若缓冲超过帧上限则视为超长行，整体丢弃
        if (this.buffer.length > this.maxFrameBytes) {
          const oversize = this.buffer.length;
          this.buffer = Buffer.alloc(0);
          this.handleProtocolFailure(`stdout 存在超过 ${this.maxFrameBytes} 字节的无换行帧（${oversize} 字节），已丢弃`);
        }
        break;
      }
      if (newline > this.maxFrameBytes) {
        // 超长帧：拒绝整行并继续找下一行
        this.buffer = this.buffer.subarray(newline + 1);
        this.handleProtocolFailure(`stdout 帧超过 ${this.maxFrameBytes} 字节上限，已拒绝`);
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
      this.handleProtocolFailure("stdout 存在非法 JSON 帧，已拒绝");
      return;
    }
    if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      this.handleProtocolFailure("stdout 帧不是合法的 JSON-RPC 2.0 消息，已拒绝");
      return;
    }
    const record = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    const hasId = record.id !== undefined;
    if (hasId && (record.error !== undefined || record.result !== undefined)) {
      // 响应：按 id 匹配 pending；未知 id（迟到/取消后）忽略
      const id = record.id as number | string;
      const pending = this.pending.get(id);
      if (pending === undefined) {
        return;
      }
      pending.cleanup();
      if (record.error !== undefined) {
        const error = record.error as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(
          new RpcTransportError("protocol-error", typeof error.message === "string" ? error.message.slice(0, 512) : "worker 返回未知错误"),
        );
        return;
      }
      pending.resolve(record.result);
      return;
    }
    if (hasId && typeof record.method === "string") {
      // worker → host 请求：未注入 handler 时缺省回 method-not-found（向后兼容）
      if (this.onRequest === undefined) {
        this.writeResponse(record.id as number | string, undefined, {
          code: JSON_RPC_ERROR_CODES.methodNotFound,
          message: `平台暂不支持 worker 主动请求 ${record.method}`,
        });
        return;
      }
      void this.handleWorkerRequest(record as { id: unknown; method: unknown; params?: unknown; carrier?: unknown });
      return;
    }
    if (!hasId && typeof record.method === "string") {
      // 通知：交给上层（携带 carrier 由 CarrierRegistry 一次性消费）
      const notification: JsonRpcNotificationMessage = {
        jsonrpc: "2.0",
        method: record.method,
        ...((record as { params?: unknown }).params !== undefined ? { params: (record as { params?: unknown }).params } : {}),
        ...((record as { carrier?: PluginIpcCarrier }).carrier !== undefined ? { carrier: (record as { carrier?: PluginIpcCarrier }).carrier } : {}),
      };
      try {
        this.onNotification?.(notification);
      } catch {
        // 通知处理失败不影响协议
      }
      return;
    }
    this.handleProtocolFailure("无法识别的 JSON-RPC 消息，已拒绝");
  }

  private handleProtocolFailure(reason: string): void {
    this.failAll(new RpcTransportError("protocol-error", reason));
    if (this.errorHandler !== undefined) {
      this.errorHandler(new RpcTransportError("protocol-error", reason));
    }
  }

  /** 处理 worker 主动请求：等待 handler 结果并回写响应（result 或映射后的 error）。 */
  private async handleWorkerRequest(record: { id: unknown; method: unknown; params?: unknown; carrier?: unknown }): Promise<void> {
    const id = record.id as number | string;
    const message: JsonRpcWorkerRequest = {
      id,
      method: record.method as string,
      ...((record as { params?: unknown }).params !== undefined ? { params: (record as { params?: unknown }).params } : {}),
      ...((record as { carrier?: PluginIpcCarrier }).carrier !== undefined ? { carrier: (record as { carrier?: PluginIpcCarrier }).carrier } : {}),
    };
    try {
      const result = await Promise.resolve(this.onRequest?.(message));
      this.writeResponse(id, result ?? null, undefined);
    } catch (error) {
      this.writeResponse(id, undefined, this.toRpcError(error));
    }
  }

  /** 抛出错误 → JSON-RPC error 结构（RpcRequestError 携带错误码，其余按 internal）。 */
  private toRpcError(error: unknown): { code: number; message: string } {
    if (error instanceof RpcRequestError) {
      return { code: error.code, message: error.message.slice(0, 512) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: JSON_RPC_ERROR_CODES.internalError, message: `处理 worker 主动请求失败：${message.slice(0, 480)}` };
  }

  /** 回写 worker 主动请求的响应；成功时 result 必填（undefined 按 null，JSON-RPC 2.0）。 */
  private writeResponse(id: number | string, result: unknown | undefined, error: { code: number; message: string } | undefined): void {
    const response: PluginRpcResponse = {
      jsonrpc: "2.0",
      id,
      ...(error !== undefined ? { error } : { result: result ?? null }),
    };
    try {
      this.writeLine(JSON.stringify(response));
    } catch {
      // 连接已关闭：忽略
    }
  }

  private failAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private writeLine(line: string): void {
    if (this.closed) {
      throw new RpcTransportError("connection-closed", "连接已关闭，无法写入");
    }
    const frame = Buffer.from(line, "utf8");
    if (frame.byteLength > this.maxFrameBytes) {
      throw new RpcTransportError("oversize-frame", `发送帧超过 ${this.maxFrameBytes} 字节上限`);
    }
    this.deps.transport.stdin.write(Buffer.concat([frame, Buffer.from("\n", "utf8")]));
  }
}
