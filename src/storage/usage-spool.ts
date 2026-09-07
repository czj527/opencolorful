import type Database from "better-sqlite3";

import { instrument } from "../observability/instrument.js";
import type { UsageRecordInput, UsageStore } from "./usage-store.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复（§10-2）：usage durable spool / reconciliation。
//
// 缺陷背景：三处用量摄取点写 usage_records 失败时的处理是"吞错 / 告警 / 无守卫"
// （usage-recorder.ts 的 utility 捕获、usage-ingestion.ts 的 instrument.warn、
// 主会话 turn 终态路径完全裸奔）——账目静默丢失，违背"所有来源用量可查"的 A8 承诺。
//
// 修复契约：
// 1. 落账失败 → 原始 UsageRecordInput（JSON 序列化）写入 usage_pending（v16）。
//    spool 与 usage_records 同库：摄取失败通常意味着库暂时不可写（锁竞争/迁移
//    窗口），此时 spool 同样可能失败——调用方仍保留吞错+诊断（写库失败无法再
//    找到更持久的落点），但成功路径的失败（CHECK/约束/程序缺陷）会被 spool 兜住。
// 2. reconcile() 重放 spool 行回 UsageStore.record（dedupe_key 幂等，与
//    usage_records 的 UNIQUE 对齐），成功即删行；单行失败记 attempts/last_error
//    并继续其余行（毒行不阻塞队首）。
// 3. 触发时机：启动时（openMetadataDatabase 之后组合根调用一次）+ 每次 enqueue
//    失败后的延迟重试（timer 串行化，不并发重放）。
// 4. spool 行只含账目数值与关联维度（与 usage_records 同级敏感度）——无消息正文、
//    无 prompt/completion、无凭据；last_error 截断 200 字符且不含敏感输入。
// ═══════════════════════════════════════════════════════════════

interface UsagePendingRow {
  id: number;
  dedupe_key: string;
  payload: string;
  reason: string;
  attempts: number;
}

export interface UsageSpoolOptions {
  readonly database: Database.Database;
  readonly usageStore: UsageStore;
  /** 重试延迟（ms），默认 30s；测试可注入 0 */
  readonly retryDelayMs?: number;
}

export class UsageSpool {
  private readonly database: Database.Database;
  private readonly usageStore: UsageStore;
  private readonly retryDelayMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private disposed = false;

  constructor(options: UsageSpoolOptions) {
    this.database = options.database;
    this.usageStore = options.usageStore;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
  }

  /**
   * 摄取点统一入口：先走正常落账；失败时把原始输入落 spool 并安排延迟重试。
   * 成功返回 "recorded"，spool 兜底成功返回 "spooled"（诊断用，不改变调用方语义）。
   * spool 本身也失败（库完全不可写）时吞错 + error 诊断——账目丢失到此为止，
   * 绝不向调用方（turn 终态/utility 调用）传播。
   */
  recordWithSpool(input: UsageRecordInput): "recorded" | "spooled" {
    try {
      this.usageStore.record(input);
      return "recorded";
    } catch (recordError) {
      const reason = recordError instanceof Error ? recordError.message.slice(0, 200) : "unknown";
      try {
        this.enqueue(input, reason);
        instrument.warn("usage.spool.enqueued", "用量落账失败已入 spool 待对账", {
          dedupeKeyPrefix: spoolKeyPrefix(input),
          reason: reason.slice(0, 160),
        });
        this.scheduleRetry();
        return "spooled";
      } catch (spoolError) {
        instrument.error("usage.spool.enqueue_failed", "用量落账与 spool 均失败，账目丢失", {
          dedupeKeyPrefix: spoolKeyPrefix(input),
          recordReason: reason.slice(0, 120),
          spoolReason: spoolError instanceof Error ? spoolError.message.slice(0, 120) : "unknown",
        });
        return "spooled";
      }
    }
  }

  /** 启动对账：重放历史 spool 行（组合根在库打开后调用一次）。 */
  reconcile(): { replayed: number; remaining: number } {
    return this.reconcileOnce("startup");
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 落 spool 行：payload 序列化失败按不可恢复处理（输入含不可序列化值属程序缺陷）。 */
  private enqueue(input: UsageRecordInput, reason: string): void {
    const payload = JSON.stringify(input);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO usage_pending (dedupe_key, payload, reason, attempts, enqueued_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(spoolDedupeKey(input), payload, reason.slice(0, 200), now, now);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      try {
        this.reconcileOnce("retry");
      } catch {
        // reconcileOnce 内部已逐行捕获；此处防御调度路径本身的意外
      }
    }, this.retryDelayMs);
    // 不持有事件循环（进程可正常退出）
    this.retryTimer.unref?.();
  }

  /** 重放一次：逐行 record，成功即删；失败行 attempts+1 并保留（毒行不阻塞队首）。 */
  private reconcileOnce(trigger: "startup" | "retry"): { replayed: number; remaining: number } {
    if (this.reconciling) return { replayed: 0, remaining: this.pendingCount() };
    this.reconciling = true;
    let replayed = 0;
    try {
      const rows = this.database
        .prepare("SELECT id, dedupe_key, payload, reason, attempts FROM usage_pending ORDER BY id ASC")
        .all() as UsagePendingRow[];
      if (rows.length === 0) return { replayed: 0, remaining: 0 };

      const updateStmt = this.database.prepare(
        "UPDATE usage_pending SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
      );
      const deleteStmt = this.database.prepare("DELETE FROM usage_pending WHERE id = ?");

      for (const row of rows) {
        try {
          const input = JSON.parse(row.payload) as UsageRecordInput;
          this.usageStore.record(input);
          deleteStmt.run(row.id);
          replayed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 200) : "unknown";
          updateStmt.run(message, new Date().toISOString(), row.id);
          instrument.warn("usage.spool.replay_failed", "spool 对账单行重放失败，保留待下轮", {
            trigger,
            dedupeKeyPrefix: row.dedupe_key.slice(0, 80),
            reason: message.slice(0, 160),
          });
        }
      }
      if (replayed > 0) {
        instrument.info("usage.spool.reconciled", "usage spool 对账完成", { trigger, replayed, remaining: rows.length - replayed });
      }
      return { replayed, remaining: rows.length - replayed };
    } finally {
      this.reconciling = false;
    }
  }

  private pendingCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM usage_pending").get() as { count: number };
    return row.count;
  }
}

/** spool 行的幂等键：与 UsageStore.record 的推导规则一致（跨来源不共享键空间）。 */
function spoolDedupeKey(input: UsageRecordInput): string {
  const source = input.source ?? "main";
  return (
    input.dedupeKey ??
    (source === "main"
      ? `${input.sessionId ?? ""}:${input.turnId ?? ""}`
      : source === "subagent"
        ? `run:${input.runId ?? ""}`
        : `call:${input.callId ?? ""}`)
  );
}

/** 诊断用键前缀（只露来源与首段标识，不露完整会话/turn id） */
function spoolKeyPrefix(input: UsageRecordInput): string {
  return spoolDedupeKey(input).slice(0, 40);
}
