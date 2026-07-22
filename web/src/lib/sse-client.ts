import type { PlatformEventEnvelope } from "./types.js";

export interface SseClientOptions {
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly onEvent: (event: PlatformEventEnvelope) => void;
  readonly onError?: (error: Error) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export class SseClient {
  private eventSource: EventSource | null = null;
  private lastSequence = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly onEvent: (event: PlatformEventEnvelope) => void;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onOpen: (() => void) | undefined;
  private readonly onClose: (() => void) | undefined;

  constructor(options: SseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.sessionId = options.sessionId;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
  }

  connect(): void {
    if (this.disposed) return;
    this.disconnect();

    const url = `${this.baseUrl}/api/sessions/${this.sessionId}/events`;
    const source = new EventSource(url);
    this.eventSource = source;

    source.onopen = () => {
      this.reconnectAttempts = 0;
      this.onOpen?.();
    };

    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as PlatformEventEnvelope;
        this.lastSequence = Math.max(this.lastSequence, event.sequence);
        this.onEvent(event);
      } catch {
        // Ignore malformed events
      }
    };

    source.onerror = () => {
      source.close();
      this.eventSource = null;
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.onClose?.();
  }

  getLastSequence(): number {
    return this.lastSequence;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) {
        this.onError?.(new Error("SSE 连接断开，正在重连"));
        this.connect();
      }
    }, delay);
  }
}
