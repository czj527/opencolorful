import type Database from "better-sqlite3";

export interface UsageRecordInput {
  readonly sessionId: string;
  readonly turnId: string;
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
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface SessionUsageSummary extends UsageTotals {
  readonly turns: number;
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
  readonly totals: UsageTotals;
  readonly sessions: number;
  readonly turns: number;
  readonly byDay: readonly UsageSummaryByDay[];
  readonly byModel: readonly UsageSummaryByModel[];
}

interface UsageRow {
  id: number;
  session_id: string;
  turn_id: string;
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
}

interface TotalsRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
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

export class UsageStore {
  constructor(private readonly database: Database.Database) {}

  record(input: UsageRecordInput): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO usage_records
          (session_id, turn_id, provider, model, input, output, cache_read, cache_write, total_tokens, context_tokens, context_window, created_at)
         VALUES (@sessionId, @turnId, @provider, @model, @input, @output, @cacheRead, @cacheWrite, @totalTokens, @contextTokens, @contextWindow, @createdAt)`,
      )
      .run({
        sessionId: input.sessionId,
        turnId: input.turnId,
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
      });
  }

  sessionTotals(sessionId: string): SessionUsageSummary {
    const totalsRow = this.database
      .prepare(
        `SELECT
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(cache_read), 0) AS cache_read,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_records
         WHERE session_id = ?`,
      )
      .get(sessionId) as TotalsRow | undefined;

    const turnsRow = this.database
      .prepare("SELECT COUNT(*) AS count FROM usage_records WHERE session_id = ?")
      .get(sessionId) as { count: number } | undefined;

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
      turns: turnsRow?.count ?? 0,
      contextTokens: contextRow?.context_tokens ?? null,
      contextWindow: contextRow?.context_window ?? null,
    };
  }

  summary(days: number): UsageSummary {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const totalsRow = this.database
      .prepare(
        `SELECT
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(cache_read), 0) AS cache_read,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_records
         WHERE created_at >= ?`,
      )
      .get(cutoffIso) as TotalsRow | undefined;

    const sessionsRow = this.database
      .prepare("SELECT COUNT(DISTINCT session_id) AS count FROM usage_records WHERE created_at >= ?")
      .get(cutoffIso) as { count: number } | undefined;

    const turnsRow = this.database
      .prepare("SELECT COUNT(*) AS count FROM usage_records WHERE created_at >= ?")
      .get(cutoffIso) as { count: number } | undefined;

    const byDayRows = this.database
      .prepare(
        `SELECT
          substr(created_at, 1, 10) AS date,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(cache_read), 0) AS cache_read,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_records
         WHERE created_at >= ?
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date ASC`,
      )
      .all(cutoffIso) as Array<TotalsRow & { date: string }>;

    const byModelRows = this.database
      .prepare(
        `SELECT
          provider,
          model,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(cache_read), 0) AS cache_read,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_records
         WHERE created_at >= ?
         GROUP BY provider, model
         ORDER BY total_tokens DESC`,
      )
      .all(cutoffIso) as Array<TotalsRow & { provider: string; model: string }>;

    return {
      days,
      totals: mapTotals(totalsRow),
      sessions: sessionsRow?.count ?? 0,
      turns: turnsRow?.count ?? 0,
      byDay: byDayRows.map((row) => ({
        date: row.date,
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        totalTokens: row.total_tokens,
      })),
      byModel: byModelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        totalTokens: row.total_tokens,
      })),
    };
  }
}
