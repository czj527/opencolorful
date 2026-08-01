import type Database from "better-sqlite3";
import type {
  MemoryRecallEntry,
  MemoryRecallLayer,
  MemoryRecallStatus,
  MemoryRecallTargetType,
  RecallEpisode,
} from "../../contracts/memory.js";

// ─── row types ───────────────────────────────────────────────────

interface RecallRow {
  id: number;
  agent_id: string;
  session_id: string;
  turn_id: string | null;
  recall_id: string;
  target_type: string;
  target_id: string;
  query_hash: string;
  layer: string;
  source_type: string;
  created_at: string;
}

interface EpisodeRow {
  id: string;
  agent_id: string;
  session_id: string;
  turn_id: string | null;
  status: string;
  result_count: number;
  started_at: string;
  completed_at: string | null;
}

interface RecallEventRow {
  id: number;
  episode_id: string;
  recall_id: string;
  agent_id: string;
  session_id: string;
  turn_id: string | null;
  layer: string | null;
  status: string;
  result_count: number;
  created_at: string;
}

// ─── domain types ────────────────────────────────────────────────

/** memory_recall_events 行（SSE Replay 用） */
export interface MemoryRecallEvent {
  readonly id: number;
  readonly episodeId: string;
  readonly recallId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly layer?: MemoryRecallLayer;
  readonly status: MemoryRecallStatus;
  readonly resultCount: number;
  readonly createdAt: string;
}

// ─── mapRow helpers ──────────────────────────────────────────────

function mapRecallRow(row: RecallRow): MemoryRecallEntry {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    recallId: row.recall_id,
    targetType: row.target_type as MemoryRecallTargetType,
    targetId: row.target_id,
    queryHash: row.query_hash,
    layer: row.layer as MemoryRecallLayer,
    sourceType: row.source_type,
    createdAt: row.created_at,
  };
}

function mapEpisodeRow(row: EpisodeRow): RecallEpisode {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    status: row.status as MemoryRecallStatus,
    resultCount: row.result_count,
    startedAt: row.started_at,
    ...(row.completed_at !== null
      ? { completedAt: row.completed_at }
      : {}),
  };
}

function mapRecallEventRow(row: RecallEventRow): MemoryRecallEvent {
  return {
    id: row.id,
    episodeId: row.episode_id,
    recallId: row.recall_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.layer !== null
      ? { layer: row.layer as MemoryRecallLayer }
      : {}),
    status: row.status as MemoryRecallStatus,
    resultCount: row.result_count,
    createdAt: row.created_at,
  };
}

// ─── input types ─────────────────────────────────────────────────

export interface MemoryRecallEntryInput {
  agentId: string;
  sessionId: string;
  turnId?: string;
  recallId: string;
  targetType: MemoryRecallTargetType;
  targetId: string;
  queryHash: string;
  layer: MemoryRecallLayer;
  sourceType?: string;
}

export interface RecallEpisodeInput {
  id: string;
  agentId: string;
  sessionId: string;
  turnId?: string;
  status: MemoryRecallStatus;
  resultCount: number;
  startedAt: string;
}

export interface RecallEpisodeUpdate {
  status: MemoryRecallStatus;
  resultCount?: number;
  completedAt?: string;
  /** 注意：memory_recall_episodes 表当前无 layer 列；若传入，暂不持久化。 */
  layer?: MemoryRecallLayer;
}

export interface MemoryRecallEventInput {
  episodeId: string;
  recallId: string;
  agentId: string;
  sessionId: string;
  turnId?: string;
  layer?: MemoryRecallLayer;
  status: MemoryRecallStatus;
  resultCount: number;
}

// ─── store ───────────────────────────────────────────────────────

export class MemoryRecallStore {
  constructor(private readonly database: Database.Database) {}

  // ── recall ledger ────────────────────────────────────────────

  /** 追加一条回想记录（id 自增） */
  appendRecall(input: MemoryRecallEntryInput): MemoryRecallEntry {
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO memory_recalls
          (agent_id, session_id, turn_id, recall_id, target_type,
           target_id, query_hash, layer, source_type, created_at)
         VALUES (
           @agentId, @sessionId, @turnId, @recallId, @targetType,
           @targetId, @queryHash, @layer, @sourceType, @createdAt
         )`,
      )
      .run({
        agentId: input.agentId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        recallId: input.recallId,
        targetType: input.targetType,
        targetId: input.targetId,
        queryHash: input.queryHash,
        layer: input.layer,
        sourceType: input.sourceType ?? "memory_recall",
        createdAt,
      });
    const row = this.database
      .prepare("SELECT * FROM memory_recalls WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as RecallRow;
    return mapRecallRow(row);
  }

  /** 列出 Agent 的 recall ledger（Phase 10.5 聚合用） */
  listByAgent(
    agentId: string,
    opts?: { since?: string; limit?: number },
  ): MemoryRecallEntry[] {
    const conditions: string[] = ["agent_id = ?"];
    const params: unknown[] = [agentId];
    if (opts?.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    const limit = opts?.limit ?? 100;
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_recalls
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as RecallRow[];
    return rows.map(mapRecallRow);
  }

  // ── episodes ─────────────────────────────────────────────────

  createEpisode(input: RecallEpisodeInput): RecallEpisode {
    this.database
      .prepare(
        `INSERT INTO memory_recall_episodes
          (id, agent_id, session_id, turn_id, status, result_count,
           started_at)
         VALUES (
           @id, @agentId, @sessionId, @turnId, @status, @resultCount,
           @startedAt
         )`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        status: input.status,
        resultCount: input.resultCount,
        startedAt: input.startedAt,
      });
    return this.getEpisode(input.id) as RecallEpisode;
  }

  updateEpisode(id: string, update: RecallEpisodeUpdate): RecallEpisode {
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [update.status];

    if (update.resultCount !== undefined) {
      sets.push("result_count = ?");
      params.push(update.resultCount);
    }
    if (update.completedAt !== undefined) {
      sets.push("completed_at = ?");
      params.push(update.completedAt);
    }
    // layer 暂不持久化（memory_recall_episodes 表当前无此列）

    params.push(id);
    const result = this.database
      .prepare(
        `UPDATE memory_recall_episodes SET ${sets.join(", ")} WHERE id = ?`,
      )
      .run(...params);
    if (result.changes !== 1) {
      throw new Error(`回想 Episode 不存在: ${id}`);
    }
    return this.getEpisode(id) as RecallEpisode;
  }

  getEpisode(id: string): RecallEpisode | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_recall_episodes WHERE id = ?")
      .get(id) as EpisodeRow | undefined;
    return row ? mapEpisodeRow(row) : undefined;
  }

  // ── recall events（SSE Replay） ──────────────────────────────

  /** 追加一条 episode 状态变更事件 */
  appendRecallEvent(input: MemoryRecallEventInput): MemoryRecallEvent {
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO memory_recall_events
          (episode_id, recall_id, agent_id, session_id, turn_id,
           layer, status, result_count, created_at)
         VALUES (
           @episodeId, @recallId, @agentId, @sessionId, @turnId,
           @layer, @status, @resultCount, @createdAt
         )`,
      )
      .run({
        episodeId: input.episodeId,
        recallId: input.recallId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        layer: input.layer ?? null,
        status: input.status,
        resultCount: input.resultCount,
        createdAt,
      });
    const row = this.database
      .prepare("SELECT * FROM memory_recall_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as RecallEventRow;
    return mapRecallEventRow(row);
  }

  /** 按 episode 列出所有状态变更事件（id 升序，用于 SSE Replay） */
  listRecallEventsByEpisode(episodeId: string): MemoryRecallEvent[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM memory_recall_events WHERE episode_id = ? ORDER BY id ASC",
      )
      .all(episodeId) as RecallEventRow[];
    return rows.map(mapRecallEventRow);
  }
}
