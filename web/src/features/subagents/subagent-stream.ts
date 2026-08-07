// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：`subagent:<threadId>` 面板流 SSE 客户端（plans/phase-14.md §17.4）
//
// 服务端（src/server/routes/subagents.ts）：
// - 每条事件带 `id: <seq>`（SQLite 持久分配，重启严格递增）；
// - stale cursor（Last-Event-ID / sinceSeq 早于环形缓冲窗口）→ `reset` 事件
//   （reason + lastSeq），随后发送 `snapshot`（当前 Thread transcript 重建基线）；
// - 实时事件类型：message / run / tool / thread；
// - Tool delta 是 transient（§17.2），断线后不可重放，只走实时广播。
//
// 客户端策略：
// - EventSource 无法设置 Last-Event-ID 头 → 断线重连时用 `sinceSeq` 查询参数
//   携带游标（服务端同样支持，parseReplayCursor 优先头、其次 query）；
// - 收到事件按 seq 去重（deliveredSeqs），UI 不重复追加；
// - reset → 通知调用方，调用方以随后到达的 snapshot 整体重建（不增量追加）；
// - 自动重连带简单退避（EventSource 自带的自动重连不带新游标，必须重建连接）。
// ═══════════════════════════════════════════════════════════════

import type {
  SubagentOwnership,
  SubagentReplayEnvelope,
  SubagentStreamEvent,
  SubagentThreadId,
  SubagentThreadTranscript,
} from "../../lib/types.js";

export type SubagentStreamConnectionStatus = "connecting" | "open" | "closed";

export interface SubagentStreamClientOptions {
  readonly baseUrl: string;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly onEvent: (event: SubagentStreamEvent) => void;
  readonly onStatusChange?: (status: SubagentStreamConnectionStatus) => void;
  /** 重连退避基数（毫秒，默认 500）；测试可注入 */
  readonly reconnectDelayMs?: number;
}

/** 面板流事件类型（与 ReplayEvent kind 一一对应 + reset/snapshot） */
const STREAM_EVENT_TYPES = ["message", "run", "tool", "thread", "reset", "snapshot"] as const;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
}

export function subagentStreamUrl(
  baseUrl: string,
  threadId: SubagentThreadId,
  ownership: SubagentOwnership,
  sinceSeq: number,
): string {
  const params = new URLSearchParams({
    ownerAgentId: ownership.ownerAgentId,
    parentSessionId: ownership.parentSessionId,
    sinceSeq: String(Math.max(0, sinceSeq)),
  });
  return `${baseUrl.replace(/\/$/, "")}/api/subagents/threads/${encodeURIComponent(threadId)}/stream?${params.toString()}`;
}

export class SubagentStreamClient {
  private readonly baseUrl: string;
  private readonly threadId: SubagentThreadId;
  private readonly ownership: SubagentOwnership;
  private readonly onEvent: (event: SubagentStreamEvent) => void;
  private readonly onStatusChange: ((status: SubagentConnectionStatus) => void) | undefined;
  private readonly reconnectDelayMs: number;

  private source: EventSourceLike | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = 0;
  private readonly deliveredSeqs = new Set<number>();
  private connectionStatus: SubagentConnectionStatus = "closed";

  constructor(options: SubagentStreamClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.threadId = options.threadId;
    this.ownership = options.ownership;
    this.onEvent = options.onEvent;
    this.onStatusChange = options.onStatusChange;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
  }

  /** 已收到的最大 sequence（断线重连游标；重置连接后保留，服务端 > cursor 不重不漏） */
  getLastSeq(): number {
    return this.lastSeq;
  }

  connect(): void {
    if (this.disposed) return;
    this.disconnect();
    this.setStatus("connecting");
    // sinceSeq = 已收最大 seq：服务端 getSince(sinceSeq) 返回 seq > sinceSeq 的事件
    const url = subagentStreamUrl(this.baseUrl, this.threadId, this.ownership, this.lastSeq);
    const source = new EventSource(url) as EventSourceLike;
    this.source = source;

    source.onopen = () => {
      if (this.disposed || this.source !== source) return;
      this.setStatus("open");
    };

    for (const type of STREAM_EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        if (this.disposed || this.source !== source) return;
        this.handleFrame(type, (message as MessageEvent).data as string, (message as MessageEvent).lastEventId);
      });
    }

    source.onmessage = (message) => {
      if (this.disposed || this.source !== source) return;
      // 兼容无 event 字段的帧：无法确定类型，忽略（服务端总是命名事件）
      void message;
    };

    source.onerror = () => {
      if (this.disposed || this.source !== source) return;
      // EventSource 自动重连会复用旧 URL（旧 sinceSeq）→ 手动关闭并按最新游标重建，
      // 服务端对 cursor 之前的重复事件按 seq 去重，UI 也不重复追加。
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source !== null) {
      const source = this.source;
      this.source = null;
      source.close();
    }
    this.setStatus("closed");
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  /** 清空去重集合（reset/snapshot 重建后调用；lastSeq 保留为服务端高水位） */
  clearDedupe(): void {
    this.deliveredSeqs.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.disposed) return;
    this.setStatus("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private setStatus(status: SubagentConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.onStatusChange?.(status);
  }

  private handleFrame(type: string, raw: string, eventId: string): void {
    // 1. seq 游标与去重（SSE id = SQLite 持久 sequence，断线重连不重不漏）
    const seq = Number(eventId);
    const numericSeq = Number.isInteger(seq) && seq >= 0 ? seq : null;

    if (type === "reset") {
      // stale cursor：调用方应以随后的 snapshot 重建（UI 不重复追加）
      let payload: { readonly reason?: string; readonly lastSeq?: number } = {};
      try {
        const parsed = JSON.parse(raw) as { readonly reason?: string; readonly lastSeq?: number };
        payload = parsed;
      } catch {
        payload = {};
      }
      if (typeof payload.lastSeq === "number" && payload.lastSeq > this.lastSeq) {
        this.lastSeq = payload.lastSeq;
      }
      this.clearDedupe();
      this.onEvent({ type: "reset", reason: payload.reason ?? "stream 已截断", lastSeq: this.lastSeq });
      return;
    }

    if (numericSeq === null) return;

    if (type === "snapshot") {
      // 初始状态或 reset 重建基线：整体替换，不增量追加
      let transcript: SubagentThreadTranscript | null = null;
      try {
        transcript = JSON.parse(raw) as SubagentThreadTranscript;
      } catch {
        transcript = null;
      }
      if (transcript !== null) {
        this.lastSeq = Math.max(this.lastSeq, numericSeq);
        this.clearDedupe();
        this.onEvent({ type: "snapshot", transcript });
      }
      return;
    }

    if (this.deliveredSeqs.has(numericSeq)) return;
    if (numericSeq <= this.lastSeq) return;
    this.deliveredSeqs.add(numericSeq);
    this.lastSeq = numericSeq;

    let envelope: SubagentReplayEnvelope | null = null;
    try {
      envelope = JSON.parse(raw) as SubagentReplayEnvelope;
    } catch {
      envelope = null;
    }
    if (envelope === null) return;
    // 未知 future event 形状：按通用行降级（不使页面崩溃）
    this.onEvent({ type: "envelope", envelope });
  }
}

export type SubagentConnectionStatus = SubagentStreamConnectionStatus;
