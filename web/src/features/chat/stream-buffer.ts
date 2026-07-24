import type { PlatformEventEnvelope } from "../../lib/types.js";

type FlushCallback = (events: PlatformEventEnvelope[]) => void;

/**
 * 按 session + stream 分桶缓冲流式事件，在每帧（requestAnimationFrame 或 33ms 回退）
 * 批量 flush，减少 React 更新频率而不改变事件顺序、持久化或 Resume 语义。
 */
export class StreamBuffer {
  private readonly onFlush: FlushCallback;
  private pending: PlatformEventEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rafId: number | null = null;
  private disposed = false;
  /** 每个 streamId 已收到的最大 sequence，用于去重。 */
  private readonly cursors = new Map<string, number>();

  constructor(onFlush: FlushCallback) {
    this.onFlush = onFlush;
  }

  push(event: PlatformEventEnvelope): void {
    if (this.disposed) return;

    const key = event.streamId ?? "__no_stream";
    const cursor = this.cursors.get(key) ?? 0;
    // 跳过乱序/重复事件
    if (event.sequence <= cursor) return;
    this.cursors.set(key, event.sequence);
    this.pending.push(event);

    if (event.type === "message.completed" || event.type === "turn.completed") {
      this.flushNow();
      return;
    }

    if (this.timer !== null || this.rafId !== null) return; // 已有待 flush

    if (typeof requestAnimationFrame === "function") {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.flushNow();
      });
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushNow();
      }, 33);
    }
  }

  flushNow(): void {
    if (this.disposed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.onFlush(batch);
  }

  dispose(): void {
    this.disposed = true;
    this.flushNow();
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.cursors.clear();
    this.pending = [];
  }
}