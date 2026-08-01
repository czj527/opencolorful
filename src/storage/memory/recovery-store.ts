import type Database from "better-sqlite3";
import type {
  MemoryDailyStep,
  MemorySchedulerState,
  MemorySchedulerStatus,
  MemoryWatermark,
  MemoryWatermarkScope,
} from "../../contracts/memory.js";

// ─── daily state ─────────────────────────────────────────────────

interface DailyStateRow {
  agent_id: string;
  date: string;
  step: string;
  done_at: string;
}

export class MemoryDailyStateStore {
  constructor(private readonly database: Database.Database) {}

  /** 幂等标记步骤完成 */
  markStepDone(
    agentId: string,
    date: string,
    step: MemoryDailyStep,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR REPLACE INTO memory_daily_state
          (agent_id, date, step, done_at)
         VALUES (@agentId, @date, @step, @doneAt)`,
      )
      .run({ agentId, date, step, doneAt: now });
  }

  /** 某天某步骤是否已完成 */
  isStepDone(
    agentId: string,
    date: string,
    step: MemoryDailyStep,
  ): boolean {
    const row = this.database
      .prepare(
        "SELECT 1 AS found FROM memory_daily_state WHERE agent_id = ? AND date = ? AND step = ?",
      )
      .get(agentId, date, step) as { found: number } | undefined;
    return row !== undefined;
  }

  /** 列出某天已完成的所有步骤 */
  listDoneSteps(agentId: string, date: string): MemoryDailyStep[] {
    const rows = this.database
      .prepare(
        "SELECT step FROM memory_daily_state WHERE agent_id = ? AND date = ? ORDER BY done_at ASC",
      )
      .all(agentId, date) as Array<{ step: string }>;
    return rows.map((row) => row.step as MemoryDailyStep);
  }
}

// ─── watermarks ──────────────────────────────────────────────────

interface WatermarkRow {
  agent_id: string;
  scope: string;
  branch_revision: string;
  cursor_json: string;
  dirty: number;
  updated_at: string;
}

function mapWatermarkRow(row: WatermarkRow): MemoryWatermark {
  return {
    agentId: row.agent_id,
    scope: row.scope as MemoryWatermarkScope,
    branchRevision: row.branch_revision,
    cursor: JSON.parse(row.cursor_json) as Record<string, unknown>,
    dirty: row.dirty === 1,
    updatedAt: row.updated_at,
  };
}

export class MemoryWatermarkStore {
  constructor(private readonly database: Database.Database) {}

  get(
    agentId: string,
    scope: MemoryWatermarkScope,
    branchRevision: string,
  ): MemoryWatermark | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM memory_watermarks WHERE agent_id = ? AND scope = ? AND branch_revision = ?",
      )
      .get(agentId, scope, branchRevision) as WatermarkRow | undefined;
    return row ? mapWatermarkRow(row) : undefined;
  }

  upsert(
    agentId: string,
    scope: MemoryWatermarkScope,
    branchRevision: string,
    cursor: Record<string, unknown>,
    dirty: boolean,
  ): MemoryWatermark {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR REPLACE INTO memory_watermarks
          (agent_id, scope, branch_revision, cursor_json, dirty, updated_at)
         VALUES (@agentId, @scope, @branchRevision, @cursorJson, @dirty, @updatedAt)`,
      )
      .run({
        agentId,
        scope,
        branchRevision,
        cursorJson: JSON.stringify(cursor),
        dirty: dirty ? 1 : 0,
        updatedAt: now,
      });
    return this.get(agentId, scope, branchRevision) as MemoryWatermark;
  }

  markDirty(
    agentId: string,
    scope: MemoryWatermarkScope,
    branchRevision: string,
  ): MemoryWatermark {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE memory_watermarks
         SET dirty = 1, updated_at = ?
         WHERE agent_id = ? AND scope = ? AND branch_revision = ?`,
      )
      .run(now, agentId, scope, branchRevision);
    if (result.changes !== 1) {
      throw new Error(
        `水位线不存在: ${agentId}/${scope}/${branchRevision}`,
      );
    }
    return this.get(agentId, scope, branchRevision) as MemoryWatermark;
  }

  listDirty(agentId: string): MemoryWatermark[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM memory_watermarks WHERE agent_id = ? AND dirty = 1 ORDER BY updated_at ASC",
      )
      .all(agentId) as WatermarkRow[];
    return rows.map(mapWatermarkRow);
  }
}

// ─── scheduler state ─────────────────────────────────────────────

interface SchedulerStateRow {
  agent_id: string;
  status: string;
  last_daily_date: string | null;
  last_daily_completed_at: string | null;
  last_weekly_completed_at: string | null;
  next_retry_at: string | null;
  updated_at: string;
}

function mapSchedulerStateRow(row: SchedulerStateRow): MemorySchedulerState {
  return {
    agentId: row.agent_id,
    status: row.status as MemorySchedulerStatus,
    ...(row.last_daily_date !== null
      ? { lastDailyDate: row.last_daily_date }
      : {}),
    ...(row.last_daily_completed_at !== null
      ? { lastDailyCompletedAt: row.last_daily_completed_at }
      : {}),
    ...(row.last_weekly_completed_at !== null
      ? { lastWeeklyCompletedAt: row.last_weekly_completed_at }
      : {}),
    ...(row.next_retry_at !== null
      ? { nextRetryAt: row.next_retry_at }
      : {}),
    updatedAt: row.updated_at,
  };
}

export class SchedulerStateStore {
  constructor(private readonly database: Database.Database) {}

  get(agentId: string): MemorySchedulerState | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduler_state WHERE agent_id = ?")
      .get(agentId) as SchedulerStateRow | undefined;
    return row ? mapSchedulerStateRow(row) : undefined;
  }

  /** 插入或替换完整的调度状态 */
  upsert(state: MemorySchedulerState): MemorySchedulerState {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR REPLACE INTO scheduler_state
          (agent_id, status, last_daily_date, last_daily_completed_at,
           last_weekly_completed_at, next_retry_at, updated_at)
         VALUES (
           @agentId, @status, @lastDailyDate, @lastDailyCompletedAt,
           @lastWeeklyCompletedAt, @nextRetryAt, @updatedAt
         )`,
      )
      .run({
        agentId: state.agentId,
        status: state.status,
        lastDailyDate: state.lastDailyDate ?? null,
        lastDailyCompletedAt: state.lastDailyCompletedAt ?? null,
        lastWeeklyCompletedAt: state.lastWeeklyCompletedAt ?? null,
        nextRetryAt: state.nextRetryAt ?? null,
        updatedAt: now,
      });
    return this.get(state.agentId) as MemorySchedulerState;
  }
}
