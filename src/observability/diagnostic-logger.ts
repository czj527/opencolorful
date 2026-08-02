import fs from "node:fs";
import path from "node:path";
import type {
  DiagnosticEnvelope,
  ObservabilityLevel,
  ProducerContext,
} from "../contracts/observability.js";
import { currentTrace } from "./trace-context.js";
import { normalizeSafeObject, redactText, sanitizeError } from "./safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 DiagnosticLogger（plans/phase-11.md §五.1 / §九）
//
// - 每进程独占双 JSONL：trace/debug → <date>_<bootId>_<segment>.debug.jsonl（7 天），
//   info+ → <date>_<bootId>_<segment>.jsonl（30 天）；
// - 单文件 10MB 轮转到下一 segment；
// - 连续完全相同记录折叠为 repeat summary；
// - 有界队列过载按 trace → debug → info 顺序丢弃（warn+ 尽量保留）；
// - 写失败 fallback stderr，不阻塞业务；总预算 500MB，超限删最旧 debug → 最旧主文件；
// - logger 不记录自己的持久化失败（避免递归风暴）。
// ═══════════════════════════════════════════════════════════════

export interface DiagnosticLoggerOptions {
  readonly logsRoot: string;
  readonly producer: ProducerContext;
  readonly fileSizeBytes?: number;
  readonly diskBudgetBytes?: number;
  readonly debugRetentionDays?: number;
  readonly mainRetentionDays?: number;
  readonly queueSize?: number;
  /** 最低记录级别（评审 P1-7：observability 偏好 diagnosticLevel 接入点） */
  readonly minLevel?: ObservabilityLevel;
  readonly now?: () => Date;
}

const LEVEL_RANK: Record<ObservabilityLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

/** 磁盘预算统计（测试可注入） */
export interface DiskUsage {
  totalBytes: number;
  debugBytes: number;
  mainBytes: number;
}

export class DiagnosticLogger {
  private readonly logsRoot: string;
  private readonly producer: ProducerContext;
  private readonly fileSizeBytes: number;
  private readonly diskBudgetBytes: number;
  private readonly debugRetentionDays: number;
  private readonly mainRetentionDays: number;
  private readonly queueSize: number;
  private readonly minLevelRank: number;
  private readonly now: () => Date;
  private queue: Array<{ line: string; level: ObservabilityLevel; signature: string }> = [];
  private pendingBatch: Array<{ line: string; level: ObservabilityLevel; signature: string }> | null = null;
  private flushing = false;
  private lastFlushAt = 0;
  private droppedCount = 0;
  private failedCount = 0;
  private readonly segment = 0;
  private degraded = false;

  constructor(options: DiagnosticLoggerOptions) {
    this.logsRoot = options.logsRoot;
    this.producer = options.producer;
    this.fileSizeBytes = options.fileSizeBytes ?? 10 * 1024 * 1024;
    this.diskBudgetBytes = options.diskBudgetBytes ?? 500 * 1024 * 1024;
    this.debugRetentionDays = options.debugRetentionDays ?? 7;
    this.mainRetentionDays = options.mainRetentionDays ?? 30;
    this.queueSize = options.queueSize ?? 1024;
    this.minLevelRank = LEVEL_RANK[options.minLevel ?? "trace"];
    this.now = options.now ?? (() => new Date());
  }

  getDroppedCount(): number { return this.droppedCount; }
  getFailedCount(): number { return this.failedCount; }
  isDegraded(): boolean { return this.degraded; }

  /** 直接落盘（不进队列）：仅用于进程退出/紧急路径 */
  flushSync(): void {
    this.flushNow(true);
  }

  trace(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("trace", eventName, message, attributes);
  }

  debug(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("debug", eventName, message, attributes);
  }

  info(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("info", eventName, message, attributes);
  }

  warn(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("warn", eventName, message, attributes);
  }

  error(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("error", eventName, message, attributes);
  }

  fatal(eventName: string, message: string, attributes?: Record<string, unknown>): void {
    this.enqueue("fatal", eventName, message, attributes);
  }

  private enqueue(level: ObservabilityLevel, eventName: string, message: string, attributes?: Record<string, unknown>): void {
    // 评审 P1-7：低于偏好级别（diagnosticLevel）的记录直接丢弃
    if (LEVEL_RANK[level] < this.minLevelRank) return;
    const trace = currentTrace();
    const now = this.now();
    let payload: import("../contracts/observability.js").DiagnosticPayload = {
      message: redactText(message).slice(0, 4_000),
    };
    if (attributes !== undefined) {
      const cleaned = normalizeSafeObject(attributes);
      if (typeof cleaned.value === "object" && cleaned.value !== null && !Array.isArray(cleaned.value)) {
        payload.attributes = cleaned.value;
      }
    }
    if (attributes?.error !== undefined) {
      const cleaned = sanitizeError(attributes.error);
      payload = { ...payload, message: `${payload.message} | ${cleaned.message}`, ...(cleaned.stack !== undefined ? { stack: cleaned.stack } : {}) };
    }
    const envelope: DiagnosticEnvelope = {
      schemaVersion: 1,
      eventVersion: 1,
      eventId: `${this.producer.bootId}-${now.getTime()}-${Math.random().toString(16).slice(2, 10)}`,
      eventName,
      occurredAt: now.toISOString(),
      recordedAt: now.toISOString(),
      level,
      actor: { kind: "system", id: this.producer.component },
      executor: { kind: "service", id: this.producer.component },
      scope: {},
      trace: trace ?? { traceId: "no-trace", spanId: "no-span" },
      producer: this.producer,
      channel: "diagnostic",
      payload,
    };
    this.queue.push({ line: JSON.stringify(envelope), level, signature: `${level}:${eventName}:${payload.message}` });
    if (this.queue.length > this.queueSize) {
      // 过载丢弃：按 trace → debug → info 顺序；warn/error/fatal 尽量保留
      const dropIndex = this.queue.findIndex((item) => LEVEL_RANK[item.level] <= 2);
      if (dropIndex >= 0) {
        this.queue.splice(dropIndex, 1);
        this.droppedCount += 1;
      }
    }
    // 批量 flush 节流：50ms 窗口
    const elapsed = now.getTime() - this.lastFlushAt;
    if (elapsed >= 50 && !this.flushing) {
      this.lastFlushAt = now.getTime();
      this.flushing = true;
      const batch = this.queue.splice(0);
      this.pendingBatch = batch;
      queueMicrotask(() => {
        const current = this.pendingBatch;
        this.pendingBatch = null;
        if (current !== null) {
          try { this.writeBatch(current); } finally { this.flushing = false; }
        } else {
          this.flushing = false;
        }
      });
    }
  }

  private flushNow(sync: boolean): void {
    // 同步路径把已排程的微任务批与队列合并同批写出：
    // 避免竞态丢行，且同一语义行的 repeat folding 计数正确
    if (sync && this.pendingBatch !== null) {
      const pending = this.pendingBatch;
      this.pendingBatch = null;
      this.flushing = false;
      const batch = [...pending, ...this.queue.splice(0)];
      this.writeBatch(batch);
      return;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    if (sync) {
      this.writeBatch(batch);
    } else {
      void Promise.resolve().then(() => this.writeBatch(batch));
    }
  }

  private writeBatch(batch: Array<{ line: string; level: ObservabilityLevel; signature: string }>): void {
    try {
      fs.mkdirSync(this.logsRoot, { recursive: true });
    } catch {
      this.emergencyStderr(batch);
      return;
    }
    // repeat folding：同批内语义相同（level+eventName+message）的行折叠为一条，
    // 输出时附带 repeat 计数（eventId/时间戳差异不参与折叠判定）。
    // 折叠窗口为单次 writeBatch——跨批的首现行已落盘无法改写，批内折叠保证计数正确。
    const order: string[] = [];
    const counts = new Map<string, { line: string; level: ObservabilityLevel; count: number }>();
    for (const item of batch) {
      const prior = counts.get(item.signature);
      if (prior !== undefined) {
        prior.count += 1;
      } else {
        counts.set(item.signature, { line: item.line, level: item.level, count: 1 });
        order.push(item.signature);
      }
    }
    for (const signature of order) {
      const item = counts.get(signature);
      if (item === undefined) continue;
      const line = item.count > 1
        ? `${item.line.slice(0, -1)},"repeat":${item.count}}`
        : item.line;
      const ok = this.writeLine(line, item.level);
      if (!ok) {
        this.failedCount += 1;
        try { process.stderr.write(`${item.line}\n`); } catch { /* emergency fallback 自身失败不再递归 */ }
      }
    }
    this.applyBudget();
  }

  private writeLine(line: string, level: ObservabilityLevel): boolean {
    const isDebugFile = LEVEL_RANK[level] <= 1;
    const date = this.dateStamp(this.now());
    const suffix = isDebugFile ? ".debug.jsonl" : ".jsonl";
    // 基础文件名含 bootId；达到 10MB 上限时滚动到带时间戳的新 segment
    const filePath = path.join(this.logsRoot, `${date}_${this.producer.bootId}_0${suffix}`);
    try {
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
      if (stat !== undefined && stat.size >= this.fileSizeBytes) {
        const rotated = `${date}_${this.producer.bootId}_${this.now().getTime()}${suffix}`;
        fs.appendFileSync(path.join(this.logsRoot, rotated), `${line}\n`, "utf8");
        return true;
      }
      fs.appendFileSync(filePath, `${line}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** 磁盘预算：超限先删最旧 debug 文件，再删最旧主文件，并标记 degraded */
  private applyBudget(): void {
    try {
      const usage = this.measureDisk();
      if (usage.totalBytes <= this.diskBudgetBytes) {
        this.degraded = false;
        return;
      }
      this.degraded = true;
      const files = fs.readdirSync(this.logsRoot)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ name, path: path.join(this.logsRoot, name), mtime: fs.statSync(path.join(this.logsRoot, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      // 评审 P1-8：删除后必须从总量扣减实际字节，否则循环会删光所有文件。
      // 阶段 1：删最旧 debug（可丢弃）；阶段 2：仍超预算再删最旧主文件。
      let total = usage.totalBytes;
      const deleteWhileOver = (debugFirst: boolean): void => {
        for (const file of files) {
          if (total <= this.diskBudgetBytes) break;
          if (file.name.endsWith(".debug.jsonl") !== debugFirst) continue;
          const size = fs.statSync(file.path).size;
          fs.unlinkSync(file.path);
          total -= size;
        }
      };
      deleteWhileOver(true);
      deleteWhileOver(false);
    } catch { /* 预算统计失败不递归告警 */ }
  }

  /** 按保留天数清理过期文件（启动与每日各一次由调用方触发） */
  enforceRetention(): void {
    try {
      if (!fs.existsSync(this.logsRoot)) return;
      const cutoffDebug = this.now().getTime() - this.debugRetentionDays * 24 * 3600 * 1000;
      const cutoffMain = this.now().getTime() - this.mainRetentionDays * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(this.logsRoot)) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(this.logsRoot, name);
        // 文件名为 <YYYY-MM-DD>_<bootId>_<segment>[.debug].jsonl：按日期前缀判定保留期
        const datePrefix = name.slice(0, 10);
        const fileDay = Date.parse(`${datePrefix}T00:00:00Z`);
        if (Number.isNaN(fileDay)) continue;
        const isDebug = name.endsWith(".debug.jsonl");
        if (fileDay < (isDebug ? cutoffDebug : cutoffMain)) {
          fs.unlinkSync(filePath);
        }
      }
    } catch { /* 保留清理失败不递归告警 */ }
  }

  /** 列出日志目录内 JSONL 文件名与字节数（retention 预览用） */
  measureDiskFiles(): Array<{ name: string; bytes: number }> {
    try {
      if (!fs.existsSync(this.logsRoot)) return [];
      return fs.readdirSync(this.logsRoot)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ name, bytes: fs.statSync(path.join(this.logsRoot, name)).size }));
    } catch {
      return [];
    }
  }

  measureDisk(): DiskUsage {
    let totalBytes = 0;
    let debugBytes = 0;
    let mainBytes = 0;
    try {
      if (!fs.existsSync(this.logsRoot)) return { totalBytes: 0, debugBytes: 0, mainBytes: 0 };
      for (const name of fs.readdirSync(this.logsRoot)) {
        if (!name.endsWith(".jsonl")) continue;
        const size = fs.statSync(path.join(this.logsRoot, name)).size;
        totalBytes += size;
        if (name.endsWith(".debug.jsonl")) debugBytes += size;
        else mainBytes += size;
      }
    } catch { /* 统计失败返回 0 */ }
    return { totalBytes, debugBytes, mainBytes };
  }

  private emergencyStderr(batch: Array<{ line: string; level: ObservabilityLevel; signature: string }>): void {
    for (const item of batch) {
      try { process.stderr.write(`${item.line}\n`); } catch { /* 忽略 */ }
    }
  }

  private dateStamp(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
}
