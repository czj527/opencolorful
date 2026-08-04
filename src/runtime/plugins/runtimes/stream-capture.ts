import { instrument } from "../../../observability/instrument.js";
import { redactText } from "../../../observability/safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 stdout/stderr 捕获（plans/phase-12.md §9.2 / §17.5）
//
// - 捕获 → 脱敏（safe-value.redactText）→ 每行限长（≤2KB）→
//   重复折叠（连续相同行合并为 [×N] 计数）→ 限速（每窗口行数上限）→ diagnostic；
// - stdout/stderr 不作为 IPC 通道、不进入 Activity payload；
//   JSON-RPC 进程的 stderr 走本捕获器；协议解析失败/越权帧由 json-rpc
//   单独处理，不回流到本通道；
// - 洪泛/超限只丢弃并计数，绝不让子进程输出拖垮 Server 或磁盘。
// ═══════════════════════════════════════════════════════════════

export const STREAM_CAPTURE_DEFAULTS = {
  maxLineBytes: 2_048,
  maxLinesPerWindow: 100,
  windowMs: 5_000,
  maxTotalBytes: 1_048_576, // 1MB
} as const;

export type CapturedStreamName = "stdout" | "stderr";

export interface StreamLineMeta {
  readonly stream: CapturedStreamName;
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  /** 折叠计数：该行在同一连续运行中的重复次数 */
  readonly repeated: number;
  /** 该行是否被截断（超过 maxLineBytes） */
  readonly truncated: boolean;
}

export interface StreamCaptureOptions {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  readonly stream: CapturedStreamName;
  readonly maxLineBytes?: number;
  readonly maxLinesPerWindow?: number;
  readonly windowMs?: number;
  readonly maxTotalBytes?: number;
  /** 覆盖 diagnostic 落点（测试注入）；缺省走 instrument.debug */
  readonly emit?: (line: string, meta: StreamLineMeta) => void;
}

export interface StreamCaptureStats {
  /** 实际发出的行数（折叠后） */
  readonly lines: number;
  /** 接收的原始字节数 */
  readonly bytes: number;
  /** 折叠掉的行数（重复行只计数不重发） */
  readonly folded: number;
  /** 被截断到 maxLineBytes 的行数 */
  readonly truncated: number;
  /** 限速丢弃的行数 */
  readonly rateLimited: number;
  /** 超过总字节预算被整体丢弃的原始字节数 */
  readonly droppedBytes: number;
}

interface MutableStats {
  lines: number;
  bytes: number;
  folded: number;
  truncated: number;
  rateLimited: number;
  droppedBytes: number;
}

export class StreamCapture {
  private readonly pluginId: string;
  private readonly runtimeInstanceId: string;
  private readonly streamName: CapturedStreamName;
  private readonly maxLineBytes: number;
  private readonly maxLinesPerWindow: number;
  private readonly windowMs: number;
  private readonly maxTotalBytes: number;
  private readonly emit: ((line: string, meta: StreamLineMeta) => void) | undefined;
  private buffer = "";
  private currentLine = "";
  private currentCount = 0;
  private windowStartedAt = Date.now();
  private windowLineCount = 0;
  private stats: MutableStats = {
    lines: 0,
    bytes: 0,
    folded: 0,
    truncated: 0,
    rateLimited: 0,
    droppedBytes: 0,
  };
  private ended = false;

  constructor(options: StreamCaptureOptions) {
    this.pluginId = options.pluginId;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.streamName = options.stream;
    this.maxLineBytes = options.maxLineBytes ?? STREAM_CAPTURE_DEFAULTS.maxLineBytes;
    this.maxLinesPerWindow = options.maxLinesPerWindow ?? STREAM_CAPTURE_DEFAULTS.maxLinesPerWindow;
    this.windowMs = options.windowMs ?? STREAM_CAPTURE_DEFAULTS.windowMs;
    this.maxTotalBytes = options.maxTotalBytes ?? STREAM_CAPTURE_DEFAULTS.maxTotalBytes;
    this.emit = options.emit;
  }

  /** 接收子进程输出块（Buffer 或 string）。 */
  write(chunk: Buffer | string): void {
    if (this.ended) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const rawBytes = Buffer.byteLength(text, "utf8");
    if (this.stats.bytes + rawBytes > this.maxTotalBytes) {
      // 总字节预算：超限整体丢弃新块并计数（保命优先）
      this.stats.droppedBytes += rawBytes;
      return;
    }
    this.stats.bytes += rawBytes;
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.ingestLine(line);
    }
  }

  /** 子进程退出时冲刷残余半行与折叠计数。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.ingestLine(line);
    }
    this.emitRun();
  }

  getStats(): StreamCaptureStats {
    return { ...this.stats };
  }

  getEnded(): boolean {
    return this.ended;
  }

  // ── 内部：逐行处理 ──────────────────────────────────────────

  private resetWindowIfElapsed(): void {
    if (Date.now() - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = Date.now();
      this.windowLineCount = 0;
    }
  }

  private ingestLine(rawLine: string): void {
    // 1) 脱敏
    let line = redactText(rawLine);
    // 2) 限长（≤2KB）
    let truncated = false;
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      const cut = Buffer.from(line, "utf8").subarray(0, this.maxLineBytes).toString("utf8");
      line = `${cut}[…truncated]`;
      truncated = true;
    }
    if (truncated) this.stats.truncated += 1;
    // 3) 重复折叠：与当前运行行相同 → 计数，不重发
    if (line === this.currentLine) {
      this.currentCount += 1;
      this.stats.folded += 1;
      return;
    }
    // 新的一行 → 先冲刷上一运行，再开始新运行（下次超替/结束时才发出）
    this.emitRun();
    this.currentLine = line;
    this.currentCount = 1;
  }

  private emitRun(): void {
    if (this.currentLine === "") {
      return;
    }
    const line = this.currentLine;
    const repeated = this.currentCount;
    const truncated = line.endsWith("[…truncated]");
    this.currentLine = "";
    this.currentCount = 0;
    // 4) 限速：滑动窗口行数上限，超出只计数不落盘
    this.resetWindowIfElapsed();
    if (this.windowLineCount >= this.maxLinesPerWindow) {
      this.stats.rateLimited += 1;
      return;
    }
    this.windowLineCount += 1;
    this.stats.lines += 1;
    const meta: StreamLineMeta = {
      stream: this.streamName,
      pluginId: this.pluginId,
      runtimeInstanceId: this.runtimeInstanceId,
      repeated,
      truncated,
    };
    if (this.emit !== undefined) {
      this.emit(line, meta);
      return;
    }
    instrument.debug("plugin.process.output", line, {
      pluginId: meta.pluginId,
      runtimeInstanceId: meta.runtimeInstanceId,
      stream: meta.stream,
      repeated,
      truncated,
    });
  }
}
