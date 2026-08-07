import type Database from "better-sqlite3";

import type { SubagentThreadId } from "../../../contracts/subagents.js";
import type { SubagentMessageRecord } from "../stores/message-store.js";
import type { SubagentRunRecord } from "../stores/run-store.js";
import type { SubagentToolActivityView } from "./tool-summary.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：`subagent:<threadId>` Replay Store（plans/phase-14.md §17.4）
//
// - stream sequence 由 SQLite 持久分配（observability_state 键
//   `subagent.replay.seq.<threadId>`，复用 Phase 11 高水位交接的既有表与模式），
//   重启后严格递增——UI 用 SSE id 去重，断线重连不重复追加（§17.4）；
// - 事件先写本 Store 再广播（订阅者在 publish 返回前不会看到事件）；
// - getSince：sinceSeq 早于环形缓冲最旧事件且缓冲已截断 → reset:true
//   （stale cursor，服务端发送 reset + 当前 Thread snapshot，§17.4）；
// - 重启后环形缓冲为空：getSince(cursor>0) 返回 reset:true，客户端收到
//   reset + snapshot 后从持久 transcript 重建，不重复追加；
// - Tool delta 是 transient（§17.2），断线后不可重放——只走实时广播；
// - 环形缓冲有界（每 Thread MAX_EVENTS / 总 Thread MAX_THREADS，超出丢弃最旧）。
// ═══════════════════════════════════════════════════════════════

/** Thread 面板流事件（durable 部分可从 stores 重放；tool 为 transient） */
export type SubagentReplayEvent =
  | { readonly kind: "message"; readonly message: SubagentMessageRecord }
  | { readonly kind: "run"; readonly run: SubagentRunRecord }
  | { readonly kind: "tool"; readonly tool: SubagentToolActivityView }
  | { readonly kind: "thread"; readonly status: "open" | "closing" | "closed"; readonly at: string };

/** 带 SQLite 持久 sequence 的事件（SSE id = seq） */
export interface SubagentReplayEnvelope {
  readonly seq: number;
  readonly threadId: SubagentThreadId;
  readonly at: string;
  readonly event: SubagentReplayEvent;
}

export interface SubagentReplayResult {
  readonly events: readonly SubagentReplayEnvelope[];
  /** true = 游标早于可用窗口（截断/重启后缓冲为空），需 reset + snapshot */
  readonly reset: boolean;
}

export type SubagentReplaySubscriber = (envelope: SubagentReplayEnvelope) => void;

interface ThreadBuffer {
  events: SubagentReplayEnvelope[];
  truncated: boolean;
}

const MAX_EVENTS_PER_THREAD = 1_000;
const MAX_RETAINED_THREADS = 100;
const REPLAY_SEQ_KEY_PREFIX = "subagent.replay.seq.";

function seqKeyOf(threadId: string): string {
  return `${REPLAY_SEQ_KEY_PREFIX}${threadId}`;
}

export class SubagentReplayStore {
  private readonly threads = new Map<SubagentThreadId, ThreadBuffer>();
  private readonly subscribers = new Set<SubagentReplaySubscriber>();

  constructor(
    private readonly database: Database.Database,
    private readonly options: { readonly maxEventsPerThread?: number; readonly maxThreads?: number } = {},
  ) {}

  /**
   * 发布事件：SQLite 事务内分配严格递增 sequence（重启不重复）→ 写入环形缓冲
   * → 异步广播。先写本 Store 再广播（§17.4：事件先写 Replay Store 再广播）。
   */
  publish(threadId: SubagentThreadId, event: SubagentReplayEvent): SubagentReplayEnvelope {
    const seq = this.allocateSequence(threadId);
    const at = event.kind === "message"
      ? event.message.createdAt
      : event.kind === "run"
        ? event.run.updatedAt
        : event.kind === "tool"
          ? event.tool.startedAt
          : event.at;
    const envelope: SubagentReplayEnvelope = { seq, threadId, at, event };

    let buffer = this.threads.get(threadId);
    if (buffer === undefined) {
      while (this.threads.size >= this.maxThreads()) {
        const oldestThreadId = this.threads.keys().next().value as SubagentThreadId | undefined;
        if (oldestThreadId === undefined) break;
        this.threads.delete(oldestThreadId);
      }
      buffer = { events: [], truncated: false };
      this.threads.set(threadId, buffer);
    }
    buffer.events.push(envelope);
    if (buffer.events.length > this.maxEventsPerThread()) {
      buffer.events = buffer.events.slice(-this.maxEventsPerThread());
      buffer.truncated = true;
    }

    for (const subscriber of this.subscribers) {
      setImmediate(() => {
        if (this.subscribers.has(subscriber)) {
          try {
            subscriber(envelope);
          } catch {
            // 慢客户端/面板写入失败不影响事件发布
          }
        }
      });
    }
    return envelope;
  }

  /** 从 sinceSeq 之后取事件；stale/截断 → reset（调用方发 reset + snapshot） */
  getSince(threadId: SubagentThreadId, sinceSeq: number): SubagentReplayResult {
    const buffer = this.threads.get(threadId);
    if (buffer === undefined || buffer.events.length === 0) {
      return { events: [], reset: sinceSeq > 0 };
    }
    const oldest = buffer.events[0]!;
    if (buffer.truncated && oldest.seq > sinceSeq + 1) {
      return { events: [], reset: true };
    }
    if (sinceSeq > 0 && oldest.seq > sinceSeq + 1) {
      return { events: [], reset: true };
    }
    const startIndex = buffer.events.findIndex((envelope) => envelope.seq > sinceSeq);
    if (startIndex === -1) {
      return { events: [], reset: false };
    }
    return { events: buffer.events.slice(startIndex), reset: false };
  }

  /** 当前已分配的最大 sequence（SQLite 持久；客户端断线重连前的 Last-Event-ID） */
  latestSeq(threadId: SubagentThreadId): number {
    const row = this.database
      .prepare("SELECT value FROM observability_state WHERE key = ?")
      .get(seqKeyOf(threadId)) as { value: string } | undefined;
    if (row === undefined) return 0;
    const value = Number(row.value);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  subscribe(subscriber: SubagentReplaySubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** 清空某 Thread 环形缓冲（保留 SQLite sequence——严格递增不回退） */
  reset(threadId: SubagentThreadId): void {
    this.threads.delete(threadId);
  }

  get threadCount(): number {
    return this.threads.size;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private allocateSequence(threadId: SubagentThreadId): number {
    return this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT value FROM observability_state WHERE key = ?")
        .get(seqKeyOf(threadId)) as { value: string } | undefined;
      const current = row !== undefined ? Number(row.value) : 0;
      const next = (Number.isFinite(current) && current >= 0 ? current : 0) + 1;
      this.database
        .prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES (?, ?)")
        .run(seqKeyOf(threadId), String(next));
      return next;
    })();
  }

  private maxEventsPerThread(): number {
    return this.options.maxEventsPerThread ?? MAX_EVENTS_PER_THREAD;
  }

  private maxThreads(): number {
    return this.options.maxThreads ?? MAX_RETAINED_THREADS;
  }
}
