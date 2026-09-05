import type Database from "better-sqlite3";

import type {
  UsageCallStatus,
  UsageGroupTotals,
  UsageQueryParams,
  UsageRole,
  UsageSource,
} from "../contracts/usage.js";

export interface UsageRecordInput {
  /** 主会话/子代理父会话 id；utility 全局调用为 null */
  readonly sessionId?: string | null;
  /** source=main 时必填（PI turn id）；其他来源为 null */
  readonly turnId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly contextTokens?: number | null;
  readonly contextWindow?: number | null;
  readonly createdAt: string;
  readonly source?: UsageSource;
  readonly role?: UsageRole;
  readonly status?: UsageCallStatus;
  readonly agentId?: string | null;
  readonly threadId?: string | null;
  readonly runId?: string | null;
  readonly callId?: string | null;
  /** 调用开始时间（可空：存量主会话行无此事实） */
  readonly startedAt?: string | null;
  /** 调用终态时间；缺省落 created_at */
  readonly finishedAt?: string | null;
  /**
   * 幂等键。缺省按来源推导：main = `${sessionId}:${turnId}`；subagent = `run:${runId}`；
   * utility = `call:${callId}`。跨来源不共享键空间；重复写入静默忽略（INSERT OR IGNORE）。
   */
  readonly dedupeKey?: string;
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface SessionUsageSummary extends UsageTotals {
  /** source=main 的记录数（历史语义：主会话轮次） */
  readonly turns: number;
  /** 全部来源的记录数（含本会话派生的子代理/utility 调用） */
  readonly calls: number;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
}

export interface UsageSummaryByDay extends UsageTotals {
  readonly date: string;
}

export interface UsageSummaryByModel extends UsageTotals {
  readonly provider: string;
  readonly model: string;
}

export interface UsageSummary {
  readonly days: number;
  /** 有会话归属的来源去重会话数（不含 utility 全局调用的空会话） */
  readonly sessions: number;
  /** source=main 的记录数（历史语义：主会话轮次） */
  readonly turns: number;
  /** 全部记录数 */
  readonly calls: number;
  readonly totals: UsageTotals;
  readonly byDay: readonly UsageSummaryByDay[];
  readonly byModel: readonly UsageSummaryByModel[];
  readonly bySource: readonly (UsageGroupTotals & { readonly source: UsageSource })[];
  readonly byRole: readonly (UsageGroupTotals & { readonly role: UsageRole })[];
  readonly byStatus: readonly (UsageGroupTotals & { readonly status: UsageCallStatus })[];
}

interface UsageRow {
  id: number;
  session_id: string | null;
  turn_id: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  context_tokens: number | null;
  context_window: number | null;
  created_at: string;
  source: UsageSource;
  role: UsageRole;
  status: UsageCallStatus;
  agent_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  call_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  dedupe_key: string;
}

interface TotalsRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
}

interface GroupRow extends TotalsRow {
  calls: number;
}

function mapTotals(row: TotalsRow | undefined): UsageTotals {
  return {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cacheRead: row?.cache_read ?? 0,
    cacheWrite: row?.cache_write ?? 0,
    totalTokens: row?.total_tokens ?? 0,
  };
}

function mapGroup(row: GroupRow): UsageGroupTotals {
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    totalTokens: row.total_tokens,
    calls: row.calls,
  };
}

const TOTALS_SELECT = `
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(total_tokens), 0) AS total_tokens
`;

export class UsageStore {
  constructor(private readonly database: Database.Database) {}

  record(input: UsageRecordInput): void {
    const source = input.source ?? "main";
    const dedupeKey =
      input.dedupeKey ??
      (source === "main"
        ? `${input.sessionId ?? ""}:${input.turnId ?? ""}`
        : source === "subagent"
          ? `run:${input.runId ?? ""}`
          : `call:${input.callId ?? ""}`);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO usage_records
          (session_id, turn_id, provider, model, input, output, cache_read, cache_write, total_tokens,
           context_tokens, context_window, created_at, source, role, status, agent_id, thread_id, run_id,
           call_id, started_at, finished_at, dedupe_key)
         VALUES
          (@sessionId, @turnId, @provider, @model, @input, @output, @cacheRead, @cacheWrite, @totalTokens,
           @contextTokens, @contextWindow, @createdAt, @source, @role, @status, @agentId, @threadId, @runId,
           @callId, @startedAt, @finishedAt, @dedupeKey)`,
      )
      .run({
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        provider: input.provider,
        model: input.model,
        input: input.input,
        output: input.output,
        cacheRead: input.cacheRead,
        cacheWrite: input.cacheWrite,
        totalTokens: input.totalTokens,
        contextTokens: input.contextTokens ?? null,
        contextWindow: input.contextWindow ?? null,
        createdAt: input.createdAt,
        source,
        role: input.role ?? (source === "main" ? "primary" : "secondary"),
        status: input.status ?? "completed",
        agentId: input.agentId ?? null,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        callId: input.callId ?? null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? input.createdAt,
        dedupeKey,
      });
  }

  sessionTotals(sessionId: string): SessionUsageSummary {
    const totalsRow = this.database
      .prepare(
        `SELECT ${TOTALS_SELECT}
         FROM usage_records
         WHERE session_id = ?`,
      )
      .get(sessionId) as TotalsRow | undefined;

    const countsRow = this.database
      .prepare(
        `SELECT
          COUNT(*) AS calls,
          COALESCE(SUM(CASE WHEN source = 'main' THEN 1 ELSE 0 END), 0) AS turns
         FROM usage_records
         WHERE session_id = ?`,
      )
      .get(sessionId) as { calls: number; turns: number } | undefined;

    const contextRow = this.database
      .prepare(
        `SELECT context_tokens, context_window
         FROM usage_records
         WHERE session_id = ? AND context_window IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionId) as { context_tokens: number | null; context_window: number | null } | undefined;

    return {
      ...mapTotals(totalsRow),
      turns: countsRow?.turns ?? 0,
      calls: countsRow?.calls ?? 0,
      contextTokens: contextRow?.context_tokens ?? null,
      contextWindow: contextRow?.context_window ?? null,
    };
  }

  /** 兼容入口：等价于 summaryFiltered({ days })。 */
  summary(days: number): UsageSummary {
    return this.summaryFiltered({ days });
  }

  summaryFiltered(filter: UsageQueryParams): UsageSummary {
    const days = filter.days ?? 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const conditions: string[] = ["created_at >= @cutoff"];
    const params: Record<string, string | number> = { cutoff: cutoffIso };

    if (filter.source !== undefined) {
      conditions.push("source = @source");
      params.source = filter.source;
    }
    if (filter.role !== undefined) {
      conditions.push("role = @role");
      params.role = filter.role;
    }
    if (filter.agentId !== undefined) {
      conditions.push("agent_id = @agentId");
      params.agentId = filter.agentId;
    }
    if (filter.sessionId !== undefined) {
      conditions.push("session_id = @sessionId");
      params.sessionId = filter.sessionId;
    }
    if (filter.providerId !== undefined) {
      conditions.push("provider = @providerId");
      params.providerId = filter.providerId;
    }
    if (filter.modelId !== undefined) {
      conditions.push("model = @modelId");
      params.modelId = filter.modelId;
    }
    const where = `WHERE ${conditions.join(" AND ")}`;

    const totalsRow = this.database
      .prepare(`SELECT ${TOTALS_SELECT} FROM usage_records ${where}`)
      .get(params) as TotalsRow | undefined;

    const countsRow = this.database
      .prepare(
        `SELECT
          COUNT(*) AS calls,
          COUNT(DISTINCT CASE WHEN session_id IS NOT NULL AND session_id != '' THEN session_id END) AS sessions,
          COALESCE(SUM(CASE WHEN source = 'main' THEN 1 ELSE 0 END), 0) AS turns
         FROM usage_records ${where}`,
      )
      .get(params) as { calls: number; sessions: number; turns: number } | undefined;

    const byDayRows = this.database
      .prepare(
        `SELECT
          substr(created_at, 1, 10) AS date,
          ${TOTALS_SELECT},
          COUNT(*) AS calls
         FROM usage_records ${where}
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date ASC`,
      )
      .all(params) as Array<GroupRow & { date: string }>;

    const byModelRows = this.database
      .prepare(
        `SELECT
          provider,
          model,
          ${TOTALS_SELECT},
          COUNT(*) AS calls
         FROM usage_records ${where}
         GROUP BY provider, model
         ORDER BY total_tokens DESC`,
      )
      .all(params) as Array<GroupRow & { provider: string; model: string }>;

    const bySourceRows = this.database
      .prepare(
        `SELECT source, ${TOTALS_SELECT}, COUNT(*) AS calls
         FROM usage_records ${where}
         GROUP BY source ORDER BY total_tokens DESC`,
      )
      .all(params) as Array<GroupRow & { source: UsageSource }>;

    const byRoleRows = this.database
      .prepare(
        `SELECT role, ${TOTALS_SELECT}, COUNT(*) AS calls
         FROM usage_records ${where}
         GROUP BY role ORDER BY total_tokens DESC`,
      )
      .all(params) as Array<GroupRow & { role: UsageRole }>;

    const byStatusRows = this.database
      .prepare(
        `SELECT status, ${TOTALS_SELECT}, COUNT(*) AS calls
         FROM usage_records ${where}
         GROUP BY status ORDER BY calls DESC`,
      )
      .all(params) as Array<GroupRow & { status: UsageCallStatus }>;

    return {
      days,
      totals: mapTotals(totalsRow),
      sessions: countsRow?.sessions ?? 0,
      turns: countsRow?.turns ?? 0,
      calls: countsRow?.calls ?? 0,
      byDay: byDayRows.map((row) => ({
        date: row.date,
        ...mapTotals(row),
      })),
      byModel: byModelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...mapTotals(row),
      })),
      bySource: bySourceRows.map((row) => ({ source: row.source, ...mapGroup(row) })),
      byRole: byRoleRows.map((row) => ({ role: row.role, ...mapGroup(row) })),
      byStatus: byStatusRows.map((row) => ({ status: row.status, ...mapGroup(row) })),
    };
  }
}
