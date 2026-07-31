import type Database from "better-sqlite3";
import type { SessionSummary } from "../../contracts/memory.js";

interface SummaryRow {
  session_id: string;
  branch_revision: string;
  agent_id: string | null;
  summary: string;
  message_count: number;
  cursor_json: string;
  source_start_entry: string | null;
  source_end_entry: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: SummaryRow): SessionSummary {
  return {
    sessionId: row.session_id,
    branchRevision: row.branch_revision,
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    summary: row.summary,
    messageCount: row.message_count,
    cursor: JSON.parse(row.cursor_json) as Record<string, unknown>,
    ...(row.source_start_entry !== null
      ? { sourceStartEntry: row.source_start_entry }
      : {}),
    ...(row.source_end_entry !== null
      ? { sourceEndEntry: row.source_end_entry }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SessionSummaryInput {
  sessionId: string;
  branchRevision: string;
  agentId?: string;
  summary: string;
  messageCount: number;
  cursor: Record<string, unknown>;
  sourceStartEntry?: string;
  sourceEndEntry?: string;
}

export class SessionSummaryStore {
  constructor(private readonly database: Database.Database) {}

  upsert(input: SessionSummaryInput): SessionSummary {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_summaries
          (session_id, branch_revision, agent_id, summary, message_count,
           cursor_json, source_start_entry, source_end_entry,
           created_at, updated_at)
         VALUES (
           @sessionId, @branchRevision, @agentId, @summary, @messageCount,
           @cursorJson, @sourceStartEntry, @sourceEndEntry,
           @now, @now
         )
         ON CONFLICT(session_id, branch_revision) DO UPDATE SET
           agent_id = excluded.agent_id,
           summary = excluded.summary,
           message_count = excluded.message_count,
           cursor_json = excluded.cursor_json,
           source_start_entry = excluded.source_start_entry,
           source_end_entry = excluded.source_end_entry,
           updated_at = excluded.updated_at`,
      )
      .run({
        sessionId: input.sessionId,
        branchRevision: input.branchRevision,
        agentId: input.agentId ?? null,
        summary: input.summary,
        messageCount: input.messageCount,
        cursorJson: JSON.stringify(input.cursor),
        sourceStartEntry: input.sourceStartEntry ?? null,
        sourceEndEntry: input.sourceEndEntry ?? null,
        now,
      });
    return this.get(input.sessionId, input.branchRevision) as SessionSummary;
  }

  get(
    sessionId: string,
    branchRevision: string,
  ): SessionSummary | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM session_summaries WHERE session_id = ? AND branch_revision = ?",
      )
      .get(sessionId, branchRevision) as SummaryRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByAgent(agentId: string): SessionSummary[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM session_summaries WHERE agent_id = ? ORDER BY updated_at DESC",
      )
      .all(agentId) as SummaryRow[];
    return rows.map(mapRow);
  }

  updateSummaryWithCursor(
    sessionId: string,
    branchRevision: string,
    update: {
      summary: string;
      cursor: Record<string, unknown>;
      messageCount: number;
      sourceStartEntry?: string;
      sourceEndEntry?: string;
    },
  ): SessionSummary {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE session_summaries SET
           summary = @summary,
           cursor_json = @cursorJson,
           message_count = @messageCount,
           source_start_entry = @sourceStartEntry,
           source_end_entry = @sourceEndEntry,
           updated_at = @updatedAt
         WHERE session_id = @sessionId
           AND branch_revision = @branchRevision`,
      )
      .run({
        summary: update.summary,
        cursorJson: JSON.stringify(update.cursor),
        messageCount: update.messageCount,
        sourceStartEntry: update.sourceStartEntry ?? null,
        sourceEndEntry: update.sourceEndEntry ?? null,
        updatedAt: now,
        sessionId,
        branchRevision,
      });
    if (result.changes !== 1) {
      throw new Error(
        `Session 摘要不存在: ${sessionId}/${branchRevision}`,
      );
    }
    return this.get(sessionId, branchRevision) as SessionSummary;
  }
}
