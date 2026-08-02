import type Database from "better-sqlite3";
import type { DiagnosticLogger } from "./diagnostic-logger.js";
import type { EmergencySpool } from "./emergency-spool.js";
import { assertDurableAudit, type AuditRecorder, type AuditRecordInput } from "./audit-recorder.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T9：幂等 Retention / 按日聚合 / 预算（plans/phase-11.md §九）
//
// - 同一事务：按日聚合 UPSERT（activity_daily_metrics，唯一键
//   (metric_date, owner_agent_id, metric_kind, dimension_hash) 幂等）
//   → 写 retention watermark → 删除已聚合 Activity；
// - 重复执行结果一致：watermark 前不再处理，聚合不重复累计；
// - Audit 一律不参与 retention（只能 ledger reset，见 audit-recorder）；
// - diagnostic 文件按 7/30 天保留清理；预算执行后删除最旧文件；
// - 导出/预览不修改任何源日志。
// ═══════════════════════════════════════════════════════════════

export interface RetentionPreview {
  /** 将被聚合+删除的 activity 行数（< cutoff 且 >= watermark） */
  readonly activityRows: number;
  readonly oldestRecordedAt: string | null;
  readonly newestRecordedAt: string | null;
  /** 估算释放字节（activity payload 大小总和） */
  readonly estimatedActivityBytes: number;
  /** diagnostic 文件清理预览（按保留天数） */
  readonly logFilesToDelete: string[];
  readonly logBytesToFree: number;
  readonly spoolBytes: number;
  readonly watermark: string;
}

export interface RetentionRunResult {
  /** 已聚合进 daily metrics 的行数 */
  readonly aggregated: number;
  readonly deleted: number;
  readonly watermark: string;
  readonly logFilesDeleted: string[];
  readonly logBytesFreed: number;
}

const METRIC_KIND = "activity";
const WATERMARK_KEY = "observability.retention.watermark";

export class RetentionService {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    private readonly logger?: DiagnosticLogger,
    private readonly spool?: EmergencySpool,
    /**
     * 评审 P0（第三轮）：删除属 fail-closed 清单——runRetention 的聚合/watermark/删除
     * 与 Audit 同一事务，审计未被接受（含未配置）→ 抛错 → 删除整体回滚。
     */
    private readonly audit?: AuditRecorder,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  getWatermark(): string {
    const row = this.database
      .prepare("SELECT value FROM observability_state WHERE key = ?")
      .get(WATERMARK_KEY) as { value: string } | undefined;
    return row?.value ?? "";
  }

  private setWatermark(date: string): void {
    this.database
      .prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES (?, ?)")
      .run(WATERMARK_KEY, date);
  }

  private cutoffDate(days: number): string {
    const date = new Date(this.now().getTime() - days * 24 * 3600 * 1000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  /** 预览：影响范围与释放空间（不修改任何数据） */
  previewRetention(days: number): RetentionPreview {
    const cutoff = this.cutoffDate(days);
    const watermark = this.getWatermark();
    const scope = (where: string): { where: string; params: unknown[] } => {
      const params: unknown[] = [];
      if (watermark !== "") {
        // 评审 P1-5：水位用 >=（前一次 cutoff 当天的数据不得永远落在开区间外）
        where += " AND substr(recorded_at, 1, 10) >= ?";
        params.push(watermark);
      }
      where += " AND substr(recorded_at, 1, 10) < ?";
      params.push(cutoff);
      return { where, params };
    };
    // 评审 P1（第三轮）：preview 必须与实际删除范围一致——只统计 routine
    // （notable/milestone 长期保留，preview 不得虚报它们会被删除）
    const { where, params } = scope("significance = 'routine'");
    const stats = this.database
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(MIN(recorded_at), '') AS oldest, COALESCE(MAX(recorded_at), '') AS newest,
                COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM activity_events WHERE ${where}`,
      )
      .get(...params) as { rows: number; oldest: string; newest: string; bytes: number };
    // diagnostic 文件预览（沿用 logger 实际配置的保留天数，不再硬编码 7/30）
    const logFilesToDelete: string[] = [];
    let logBytesToFree = 0;
    if (this.logger !== undefined) {
      try {
        const cutoffDebug = this.now().getTime() - this.logger.getDebugRetentionDays() * 24 * 3600 * 1000;
        const cutoffMain = this.now().getTime() - this.logger.getMainRetentionDays() * 24 * 3600 * 1000;
        for (const file of this.logger.measureDiskFiles()) {
          const datePrefix = file.name.slice(0, 10);
          const fileDay = Date.parse(`${datePrefix}T00:00:00Z`);
          if (Number.isNaN(fileDay)) continue;
          const isDebug = file.name.endsWith(".debug.jsonl");
          if (fileDay < (isDebug ? cutoffDebug : cutoffMain)) {
            logFilesToDelete.push(file.name);
            logBytesToFree += file.bytes;
          }
        }
      } catch { /* 预览失败不影响 */ }
    }
    return {
      activityRows: stats.rows,
      oldestRecordedAt: stats.oldest === "" ? null : stats.oldest,
      newestRecordedAt: stats.newest === "" ? null : stats.newest,
      estimatedActivityBytes: stats.bytes,
      logFilesToDelete,
      logBytesToFree,
      spoolBytes: this.spool?.totalBytes() ?? 0,
      watermark,
    };
  }

  /** 幂等执行：聚合 → watermark → 删除（同一事务）；重复执行结果一致 */
  runRetention(days: number, auditInput?: AuditRecordInput): RetentionRunResult {
    const cutoff = this.cutoffDate(days);
    const watermark = this.getWatermark();
    let aggregated = 0;
    let deleted = 0;
    // 评审 P0（第三轮）：审计未配置 → 拒绝执行删除（fail-closed，不再"删完才想起审计"）
    if (this.audit === undefined) {
      throw new Error("可观测性未初始化，拒绝执行 retention");
    }
    const auditEnvelope = auditInput ?? {
      eventName: "audit.observability.retention_executed",
      payload: {
        action: "observability.retention.executed",
        decision: "allowed",
        changedFields: ["activity_events"],
      },
      actor: { kind: "system", id: "retention" },
      executor: { kind: "service", id: "retention" },
    } as AuditRecordInput;
    this.database.transaction(() => {
      const params: unknown[] = [];
      let where = "1=1";
      if (watermark !== "") {
        // 评审 P1-5：闭区间（>= watermark），避免前一次 cutoff 当天的数据永远漏掉
        where += " AND substr(recorded_at, 1, 10) >= ?";
        params.push(watermark);
      }
      where += " AND substr(recorded_at, 1, 10) < ?";
      params.push(cutoff);
      // 1) 按日聚合（dimension = event_name|level|status；唯一键幂等 UPSERT）
      const rows = this.database
        .prepare(
          `SELECT substr(recorded_at, 1, 10) AS date, owner_agent_id, event_name, level, status, COUNT(*) AS count
           FROM activity_events WHERE ${where} GROUP BY substr(recorded_at, 1, 10), owner_agent_id, event_name, level, status`,
        )
        .all(...params) as Array<{ date: string; owner_agent_id: string | null; event_name: string; level: string; status: string | null; count: number }>;
      // 唯一键幂等：watermark 保证每日期每维度只聚合一次，冲突时覆盖（结果一致）
      const upsert = this.database.prepare(
        `INSERT INTO activity_daily_metrics (metric_date, owner_agent_id, metric_kind, dimension_hash, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (metric_date, owner_agent_id, metric_kind, dimension_hash)
         DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      );
      for (const row of rows) {
        const hash = simpleHash(`${row.event_name}|${row.level}|${row.status ?? ""}`);
        const value = JSON.stringify({
          count: row.count,
          eventName: row.event_name,
          level: row.level,
          status: row.status,
        });
        upsert.run(row.date, row.owner_agent_id ?? "", METRIC_KIND, hash, value, new Date().toISOString());
        aggregated += row.count;
      }
      // 2) 写 watermark（当前 cutoff 之前已全部聚合）
      this.setWatermark(cutoff);
      // 3) 删除已聚合 Activity（评审 P0-4：只删 routine；notable/milestone
      //    承诺长期保留——agent.created/agent.deleted 等不可被 retention 抹掉）
      const result = this.database
        .prepare(`DELETE FROM activity_events WHERE ${where} AND significance = 'routine'`)
        .run(...params);
      deleted = result.changes;
      // 4) 删除与 Audit 同一事务（fail-closed）：审计未被接受 → 抛错 → 删除回滚
      assertDurableAudit(this.audit!.appendStrict(auditEnvelope), "retention 删除");
    })();
    // diagnostic 文件清理（7/30 天规则；独立于 activity 事务）
    let logFilesDeleted: string[] = [];
    let logBytesFreed = 0;
    if (this.logger !== undefined) {
      const before = this.logger.measureDiskFiles();
      this.logger.enforceRetention();
      const after = new Set(this.logger.measureDiskFiles().map((file) => file.name));
      logFilesDeleted = before.filter((file) => !after.has(file.name)).map((file) => file.name);
      logBytesFreed = before.filter((file) => !after.has(file.name)).reduce((sum, file) => sum + file.bytes, 0);
    }
    return { aggregated, deleted, watermark: cutoff, logFilesDeleted, logBytesFreed };
  }
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
