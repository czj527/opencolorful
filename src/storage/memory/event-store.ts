import type Database from "better-sqlite3";
import type { MemoryEvent, MemoryEventStatus } from "../../contracts/memory.js";
import {
  buildMemoryFtsQuery,
  escapeLikePattern,
  isSingleCjkQuery,
} from "./cjk-ngram.js";

interface EventRow {
  id: string;
  agent_id: string;
  session_id: string;
  branch_revision: string;
  source_start_entry: string | null;
  source_end_entry: string | null;
  date: string;
  started_at: string;
  ended_at: string;
  summary: string;
  topics: string;
  search_text: string;
  message_count: number;
  tool_calls: number;
  duration_sec: number;
  status: string;
  created_at: string;
}

function mapRow(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    branchRevision: row.branch_revision,
    ...(row.source_start_entry !== null
      ? { sourceStartEntry: row.source_start_entry }
      : {}),
    ...(row.source_end_entry !== null
      ? { sourceEndEntry: row.source_end_entry }
      : {}),
    date: row.date,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    topics: JSON.parse(row.topics) as readonly string[],
    searchText: row.search_text,
    messageCount: row.message_count,
    toolCalls: row.tool_calls,
    durationSec: row.duration_sec,
    status: row.status as MemoryEventStatus,
    createdAt: row.created_at,
  };
}

export interface MemoryEventInput {
  id: string;
  agentId: string;
  sessionId: string;
  branchRevision: string;
  sourceStartEntry?: string;
  sourceEndEntry?: string;
  date: string;
  startedAt: string;
  endedAt: string;
  summary: string;
  topics: readonly string[];
  searchText: string;
  messageCount: number;
  toolCalls: number;
  durationSec: number;
  status: MemoryEventStatus;
}

export class MemoryEventStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 幂等插入：同一 (session_id, branch_revision, source_start_entry, source_end_entry)
   * 冲突时忽略，返回是否真正插入了新行。
   */
  insertEvent(input: MemoryEventInput): boolean {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO memory_events
          (id, agent_id, session_id, branch_revision,
           source_start_entry, source_end_entry,
           date, started_at, ended_at,
           summary, topics, search_text,
           message_count, tool_calls, duration_sec,
           status, created_at)
         VALUES (
           @id, @agentId, @sessionId, @branchRevision,
           @sourceStartEntry, @sourceEndEntry,
           @date, @startedAt, @endedAt,
           @summary, @topics, @searchText,
           @messageCount, @toolCalls, @durationSec,
           @status, @createdAt
         )`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        sessionId: input.sessionId,
        branchRevision: input.branchRevision,
        sourceStartEntry: input.sourceStartEntry ?? null,
        sourceEndEntry: input.sourceEndEntry ?? null,
        date: input.date,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        summary: input.summary,
        topics: JSON.stringify(input.topics),
        searchText: input.searchText,
        messageCount: input.messageCount,
        toolCalls: input.toolCalls,
        durationSec: input.durationSec,
        status: input.status,
        createdAt: now,
      });
    return result.changes > 0;
  }

  getById(id: string): MemoryEvent | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_events WHERE id = ?")
      .get(id) as EventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByAgentAndDateRange(
    agentId: string,
    from?: string,
    to?: string,
  ): MemoryEvent[] {
    const conditions: string[] = ["agent_id = ?"];
    const params: unknown[] = [agentId];

    // 默认排除 forgotten 和 suppressed
    conditions.push("status NOT IN ('forgotten', 'suppressed')");

    if (from) {
      conditions.push("date >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("date <= ?");
      params.push(to);
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM memory_events
         WHERE ${conditions.join(" AND ")}
         ORDER BY date DESC, started_at DESC`,
      )
      .all(...params) as EventRow[];
    return rows.map(mapRow);
  }

  /**
   * FTS5 全文搜索 + CJK 单字 LIKE 降级。默认排除 forgotten/suppressed。
   */
  searchByFts(
    agentId: string,
    query: string,
    opts?: {
      from?: string;
      to?: string;
      limit?: number;
    },
  ): MemoryEvent[] {
    const limit = opts?.limit ?? 20;

    if (isSingleCjkQuery(query)) {
      // 单字 CJK 降级为 LIKE，对 summary 列搜索
      const pattern = `%${escapeLikePattern(query)}%`;
      const conditions: string[] = [
        "agent_id = ?",
        "status NOT IN ('forgotten', 'suppressed')",
        "summary LIKE ? ESCAPE '\\'",
      ];
      const params: unknown[] = [agentId, pattern];
      if (opts?.from) {
        conditions.push("date >= ?");
        params.push(opts.from);
      }
      if (opts?.to) {
        conditions.push("date <= ?");
        params.push(opts.to);
      }
      const rows = this.database
        .prepare(
          `SELECT * FROM memory_events
           WHERE ${conditions.join(" AND ")}
           ORDER BY date DESC
           LIMIT ?`,
        )
        .all(...params, limit) as EventRow[];
      return rows.map(mapRow);
    }

    const ftsQuery = buildMemoryFtsQuery(query);
    if (!ftsQuery) {
      // 空查询退化为按日期范围列表
      return this.listByAgentAndDateRange(agentId, opts?.from, opts?.to);
    }

    const conditions: string[] = [
      "me.agent_id = ?",
      "me.status NOT IN ('forgotten', 'suppressed')",
    ];
    // SQL 中 MATCH ? 在最前，所以 ftsQuery 必须是第一个参数
    const params: unknown[] = [ftsQuery, agentId];

    if (opts?.from) {
      conditions.push("me.date >= ?");
      params.push(opts.from);
    }
    if (opts?.to) {
      conditions.push("me.date <= ?");
      params.push(opts.to);
    }

    const rows = this.database
      .prepare(
        `SELECT me.* FROM memory_events me
         JOIN memory_events_fts fts ON me.rowid = fts.rowid
         WHERE memory_events_fts MATCH ?
           AND ${conditions.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params, limit) as EventRow[];
    return rows.map(mapRow);
  }

  updateStatus(id: string, status: MemoryEventStatus): MemoryEvent {
    const result = this.database
      .prepare("UPDATE memory_events SET status = ? WHERE id = ?")
      .run(status, id);
    if (result.changes !== 1) {
      throw new Error(`事件不存在: ${id}`);
    }
    return this.getById(id) as MemoryEvent;
  }
}
