import type Database from "better-sqlite3";
import type {
  ActivityEnvelope,
  ActorRef,
  AuditEnvelope,
  EventScope,
  ExecutorRef,
  ProducerContext,
  ResourceRef,
  TraceContext,
} from "../contracts/observability.js";
import { ActivityRecorder, type ActivityRecordInput, type ActivityAcceptResult } from "./activity-recorder.js";
import { startOperation, type ActivityOperation, type ActivityOperationOptions } from "./activity-operation.js";
import { AuditRecorder, type AuditAcceptResult, type AuditRecordInput } from "./audit-recorder.js";
import { DiagnosticLogger, type DiskUsage } from "./diagnostic-logger.js";
import { EmergencySpool, type SpoolImportResult } from "./emergency-spool.js";
import {
  createBootId,
  currentTrace,
  newSpanId,
  newTraceId,
  runAsBackground,
  runWithCarrier,
  runWithTrace,
} from "./trace-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 ObservabilityContext（plans/phase-11.md §5.7）
//
// 组装 DiagnosticLogger + ActivityRecorder + AuditRecorder + EmergencySpool，
// 提供统一的 trace 上下文、启动恢复（reconcile + spool 导入）与 health 聚合。
// 调用方（server/supervisor/web 各自进程）只依赖本模块，不直接接触子组件。
// ═══════════════════════════════════════════════════════════════

export interface ObservabilityContextOptions {
  readonly database: Database.Database;
  readonly producer: ProducerContext;
  readonly logsRoot: string;
  readonly spoolRoot: string;
  /**
   * 偏好覆盖（评审 P1-7）：diagnostic 级别/文件大小/磁盘预算/保留天数
   * 与 spool 预算均来自 observability 偏好（PreferencesStore），
   * 不再使用硬编码默认值。
   */
  readonly logger?: Partial<import("./diagnostic-logger.js").DiagnosticLoggerOptions>;
  readonly spoolBudgetBytes?: number;
  readonly now?: () => Date;
}

export interface ObservabilityHealth {
  logger: { dropped: number; failed: number; degraded: boolean; disk: DiskUsage };
  spool: { failedWrites: number; pendingSegments: number; totalBytes: number };
  auditEpoch: number;
  /** 上次启动恢复的规模（重启后归零） */
  recovery: { lastInterrupted: number; lastSpoolImported: number };
}

export interface StartupRecoveryResult {
  /** 旧 boot 遗留 running/processing → interrupted 的行数 */
  interrupted: number;
  /** 应急 spool 导入结果（含 quarantine） */
  spool: SpoolImportResult;
}

export class ObservabilityContext {
  readonly logger: DiagnosticLogger;
  readonly activity: ActivityRecorder;
  readonly audit: AuditRecorder;
  readonly spool: EmergencySpool;
  private readonly database: Database.Database;
  private readonly producer: ProducerContext;
  private recovery = { interrupted: 0, spoolImported: 0 };

  /** 当前进程 producer 身份（instrument 等调用方读取） */
  getProducer(): ProducerContext {
    return this.producer;
  }

  constructor(options: ObservabilityContextOptions) {
    this.database = options.database;
    this.producer = options.producer;
    this.logger = new DiagnosticLogger({
      logsRoot: options.logsRoot,
      producer: options.producer,
      // 评审 P1-7：偏好优先，缺省回退平台默认
      ...(options.logger?.minLevel !== undefined ? { minLevel: options.logger.minLevel } : {}),
      ...(options.logger?.fileSizeBytes !== undefined ? { fileSizeBytes: options.logger.fileSizeBytes } : {}),
      ...(options.logger?.diskBudgetBytes !== undefined ? { diskBudgetBytes: options.logger.diskBudgetBytes } : {}),
      ...(options.logger?.debugRetentionDays !== undefined ? { debugRetentionDays: options.logger.debugRetentionDays } : {}),
      ...(options.logger?.mainRetentionDays !== undefined ? { mainRetentionDays: options.logger.mainRetentionDays } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.spool = new EmergencySpool({
      spoolRoot: options.spoolRoot,
      processType: options.producer.processType,
      bootId: options.producer.bootId,
      ...(options.spoolBudgetBytes !== undefined ? { budgetBytes: options.spoolBudgetBytes } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    // spool 适配器：EmergencySpool.write 同步完成，成败立即可知（fail-closed 语义）
    const spoolAdapter = {
      write: (channel: "activity" | "audit", envelope: ActivityEnvelope | AuditEnvelope) =>
        this.spool.write(channel, envelope),
    };
    this.activity = new ActivityRecorder({
      database: options.database,
      producer: options.producer,
      spool: spoolAdapter,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.audit = new AuditRecorder({
      database: options.database,
      producer: options.producer,
      spool: spoolAdapter,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  // ─── trace 上下文（透传，见 trace-context.ts） ────────────────

  currentTrace(): TraceContext | undefined { return currentTrace(); }
  newTraceId(): string { return newTraceId(); }
  newSpanId(): string { return newSpanId(); }
  createBootId(): string { return createBootId(this.producer.appVersion); }
  runWithTrace<T>(input: { trace?: TraceContext; parentSpanId?: string }, callback: () => T): T {
    return runWithTrace(input, callback);
  }
  runAsBackground<T>(input: { linkedTraceIds?: readonly string[]; operationId?: string }, callback: () => T): T {
    return runAsBackground(input, callback);
  }
  runWithCarrier<T>(carrier: TraceContext, callback: () => T): T {
    return runWithCarrier(carrier, callback);
  }

  // ─── 操作便利方法 ─────────────────────────────────────────────

  appendActivity(input: ActivityRecordInput): ActivityAcceptResult {
    return this.activity.append(input);
  }

  /** startOperation 绑定到本上下文的 activity recorder */
  startOperation(options: ActivityOperationOptions): { operation: ActivityOperation; started: ActivityAcceptResult } {
    return startOperation(this.activity, options);
  }

  appendAudit(input: AuditRecordInput): AuditAcceptResult {
    return this.audit.append(input);
  }

  /**
   * 启动恢复（server/supervisor 各自进程启动时调用一次）：
   * 1. 把 state 中记录的上一 boot（同 processType）遗留 running/processing 补为 interrupted
   *    （>24h 窗口，避免误伤共享库的其他存活进程）；
   * 2. 幂等导入本进程遗留的应急 spool；
   * 3. 记录当前 bootId，供下次启动恢复。
   */
  startupRecovery(): StartupRecoveryResult {
    const olderThanIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const lastBootKey = `observability.last_boot_id.${this.producer.processType}`;
    const prev = this.database
      .prepare("SELECT value FROM observability_state WHERE key = ?")
      .get(lastBootKey) as { value: string } | undefined;
    const interrupted = prev !== undefined && prev.value !== this.producer.bootId
      ? this.activity.reconcileRunning(prev.value, olderThanIso)
      : 0;
    const spool = this.importSpool();
    this.database
      .prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES (?, ?)")
      .run(lastBootKey, this.producer.bootId);
    this.recovery = { interrupted, spoolImported: spool.imported };
    return { interrupted, spool };
  }

  /** 幂等导入全部待导入 spool 段（按行分发 activity/audit；坏行 quarantine） */
  importSpool(): SpoolImportResult {
    return this.spool.importInto((line) => {
      const envelope = line as { channel?: unknown };
      if (typeof envelope.channel !== "string") return { ok: false, error: "quarantine" };
      if (envelope.channel === "activity") return this.activity.importEnvelope(line);
      if (envelope.channel === "audit") return this.audit.importEnvelope(line);
      return { ok: false, error: "quarantine" };
    });
  }

  /** 规范化 trace link（observability_trace_links；如后台任务 spawn 关系） */
  recordTraceLink(sourceTraceId: string, targetTraceId: string, relation: string): void {
    if (sourceTraceId === targetTraceId) return;
    try {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO observability_trace_links (source_trace_id, target_trace_id, relation, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(sourceTraceId, targetTraceId, relation.slice(0, 64), new Date().toISOString());
    } catch { /* link 记录失败不影响业务 */ }
  }

  /** 同步 flush 诊断日志（进程退出/测试收尾时调用） */
  flush(): void {
    this.logger.flushSync();
  }

  /** 进程退出前调用：flush + 保留 health 统计 */
  close(): void {
    this.flush();
  }

  /** 聚合 health（§5.7）：logger 降级、spool 状态、ledger epoch 一览 */
  getHealth(): ObservabilityHealth {
    return {
      logger: {
        dropped: this.logger.getDroppedCount(),
        failed: this.logger.getFailedCount(),
        degraded: this.logger.isDegraded(),
        disk: this.logger.measureDisk(),
      },
      spool: {
        failedWrites: this.spool.getFailedWriteCount(),
        pendingSegments: this.spool.pendingSegments(),
        totalBytes: this.spool.totalBytes(),
      },
      auditEpoch: this.audit.ledgerEpoch(),
      recovery: {
        lastInterrupted: this.recovery.interrupted,
        lastSpoolImported: this.recovery.spoolImported,
      },
    };
  }
}

export type { ActorRef, EventScope, ExecutorRef, ProducerContext, ResourceRef, TraceContext };
export type { ActivityRecordInput };
export type { AuditRecordInput };
