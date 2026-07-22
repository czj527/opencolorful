import type { PlatformEventEnvelope } from "./types.js";

// 与服务端 src/contracts/commands.ts ClientCommandSchema 对齐
export type WsClientCommand =
  | { readonly protocolVersion: 1; readonly requestId: string; readonly type: "session.subscribe"; readonly sessionId: string }
  | { readonly protocolVersion: 1; readonly requestId: string; readonly type: "session.unsubscribe"; readonly sessionId: string }
  | { readonly protocolVersion: 1; readonly requestId: string; readonly type: "session.abort"; readonly sessionId: string }
  | { readonly protocolVersion: 1; readonly requestId: string; readonly type: "session.compact"; readonly sessionId: string }
  | { readonly protocolVersion: 1; readonly requestId: string; readonly type: "stream.resume"; readonly sessionId: string; readonly streamId: string; readonly lastSequence: number };

// 与服务端 src/server/ws/protocol.ts WsServerMessageSchema 对齐
export type WsServerMessage =
  | { readonly type: "event"; readonly payload: PlatformEventEnvelope }
  | { readonly type: "ack"; readonly requestId: string; readonly status: "accepted" | "already-stopped" | "rejected" }
  | { readonly type: "error"; readonly requestId?: string; readonly code: string; readonly message: string };

export interface WsClientOptions {
  readonly baseUrl: string;
  readonly onEvent: (event: PlatformEventEnvelope) => void;
  readonly onMessage?: (message: WsServerMessage) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  readonly onError?: (error: Error) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Set<string>();
  private requestCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly baseUrl: string;
  private readonly onEvent: (event: PlatformEventEnvelope) => void;
  private readonly onMessage: ((message: WsServerMessage) => void) | undefined;
  private readonly onOpen: (() => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;

  constructor(options: WsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    this.onEvent = options.onEvent;
    this.onMessage = options.onMessage;
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
    this.onError = options.onError;
  }

  connect(): void {
    if (this.disposed) return;
    this.disconnect();

    const url = `${this.baseUrl}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      // 重连后恢复全部订阅
      for (const sessionId of this.subscriptions) {
        this.sendCommand({ protocolVersion: 1, requestId: this.nextRequestId(), type: "session.subscribe", sessionId });
      }
      this.onOpen?.();
    };

    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data as string) as WsServerMessage;
        if (data.type === "event") {
          const event = data.payload;
          if (event.sessionId && this.subscriptions.has(event.sessionId)) {
            this.onEvent(event);
          }
        }
        this.onMessage?.(data);
      } catch {
        // 忽略无法解析的消息
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      this.onError?.(new Error("WebSocket 连接错误"));
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    this.disconnect();
    this.onClose?.();
  }

  subscribe(sessionId: string): string {
    this.subscriptions.add(sessionId);
    const requestId = this.nextRequestId();
    this.sendCommand({ protocolVersion: 1, requestId, type: "session.subscribe", sessionId });
    return requestId;
  }

  unsubscribe(sessionId: string): string {
    this.subscriptions.delete(sessionId);
    const requestId = this.nextRequestId();
    this.sendCommand({ protocolVersion: 1, requestId, type: "session.unsubscribe", sessionId });
    return requestId;
  }

  abort(sessionId: string): string {
    const requestId = this.nextRequestId();
    this.sendCommand({ protocolVersion: 1, requestId, type: "session.abort", sessionId });
    return requestId;
  }

  compact(sessionId: string): string {
    const requestId = this.nextRequestId();
    this.sendCommand({ protocolVersion: 1, requestId, type: "session.compact", sessionId });
    return requestId;
  }

  resume(sessionId: string, streamId: string, lastSequence: number): string {
    const requestId = this.nextRequestId();
    this.sendCommand({ protocolVersion: 1, requestId, type: "stream.resume", sessionId, streamId, lastSequence });
    return requestId;
  }

  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${Date.now()}-${this.requestCounter}`;
  }

  private sendCommand(command: WsClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) {
        this.connect();
      }
    }, delay);
  }
}
