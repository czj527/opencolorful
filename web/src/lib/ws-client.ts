import type { PlatformEventEnvelope, WsClientCommand, WsServerMessage } from "./types.js";

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
      // Re-subscribe to all sessions after reconnect
      for (const sessionId of this.subscriptions) {
        this.send({ type: "subscribe", sessionId });
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
        // Ignore malformed messages
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

  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    this.send({ type: "subscribe", sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  abort(sessionId: string, streamId: string): void {
    this.send({ type: "abort", sessionId, streamId });
  }

  compact(sessionId: string): void {
    this.send({ type: "compact", sessionId });
  }

  resume(sessionId: string, streamId: string, lastSequence: number): void {
    this.send({ type: "resume", sessionId, streamId, lastSequence });
  }

  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(command: WsClientCommand): void {
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
