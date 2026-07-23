import type { PlatformEventEnvelope } from "./types.js";

// 与服务端 EVENT_TYPES 对齐（src/contracts/events.ts）
const KNOWN_EVENT_TYPES = [
  "health.changed",
  "session.status",
  "message.started",
  "message.delta",
  "message.completed",
  "thinking.delta",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "turn.started",
  "turn.completed",
  "plan.updated",
  "attachment.available",
  "error",
] as const;

export interface SseResetPayload {
  readonly streamId: string;
  readonly reason: string;
}

export interface SseClientOptions {
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly onEvent: (event: PlatformEventEnvelope) => void;
  readonly onReset?: (payload: SseResetPayload) => void;
  readonly onError?: (error: Error) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

/**
 * 基于 EventSource 的 SSE 客户端。
 *
 * 服务端以 `event: <type>` 发送命名事件、`id: streamId:sequence` 作为游标。
 * EventSource 自动在重连时携带 `Last-Event-ID: streamId:sequence`，
 * 服务端据此补发缺失事件（src/server/sse/session-events.ts parseReplayCursor）。
 */
export class SseClient {
  private eventSource: EventSource | null = null;
  private lastSequence = 0;
  private lastStreamId: string | null = null;
  private disposed = false;

  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly onEvent: (event: PlatformEventEnvelope) => void;
  private readonly onReset: ((payload: SseResetPayload) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onOpen: (() => void) | undefined;
  private readonly onClose: (() => void) | undefined;

  constructor(options: SseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.sessionId = options.sessionId;
    this.onEvent = options.onEvent;
    this.onReset = options.onReset;
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
      this.onOpen?.();
    };

    // 命名事件：服务端 event: <type>
    for (const type of KNOWN_EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        this.handleEnvelope((message as MessageEvent).data);
      });
    }

    // 缓存截断重置事件
    source.addEventListener("reset", (message) => {
      try {
        const payload = JSON.parse((message as MessageEvent).data as string) as SseResetPayload;
        this.lastSequence = 0;
        this.onReset?.(payload);
      } catch {
        // 忽略格式错误的 reset
      }
    });

    // 兼容默认 message 事件（无 event 字段时）
    source.onmessage = (message) => {
      this.handleEnvelope(message.data);
    };

    source.onerror = () => {
      // EventSource 自动重连并携带 Last-Event-ID；只上报状态
      if (source.readyState === EventSource.CONNECTING) {
        this.onError?.(new Error("SSE 连接断开，正在重连"));
      }
    };
  }

  disconnect(): void {
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

  getLastStreamId(): string | null {
    return this.lastStreamId;
  }

  private handleEnvelope(raw: string): void {
    try {
      const event = JSON.parse(raw) as PlatformEventEnvelope;
      if (typeof event.sequence === "number") {
        this.lastSequence = Math.max(this.lastSequence, event.sequence);
      }
      if (event.streamId) {
        this.lastStreamId = event.streamId;
      }
      this.onEvent(event);
    } catch {
      // 忽略无法解析的帧
    }
  }
}
