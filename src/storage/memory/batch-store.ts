import type Database from "better-sqlite3";
import type { MemoryBatch, MemoryBatchStatus } from "../../contracts/memory.js";

interface BatchRow {
  id: string;
  agent_id: string;
  session_id: string;
  revision_json: string;
  source_start_entry: string | null;
  source_end_entry: string | null;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: BatchRow): MemoryBatch {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    revision: JSON.parse(row.revision_json) as Record<string, unknown>,
    ...(row.source_start_entry !== null
      ? { sourceStartEntry: row.source_start_entry }
      : {}),
    ...(row.source_end_entry !== null
      ? { sourceEndEntry: row.source_end_entry }
      : {}),
    status: row.status as MemoryBatchStatus,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MemoryBatchInput {
  id: string;
  agentId: string;
  sessionId: string;
  revision: Record<string, unknown>;
  sourceStartEntry?: string;
  sourceEndEntry?: string;
  priority: number;
}

export class MemoryBatchStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 创建封存批次。调用方指定 initial status（provisional 或 sealed）。
   */
  createBatch(
    input: MemoryBatchInput,
    initialStatus: "provisional" | "sealed",
  ): MemoryBatch {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO memory_batches
          (id, agent_id, session_id, revision_json,
           source_start_entry, source_end_entry,
           status, priority, created_at, updated_at)
         VALUES (
           @id, @agentId, @sessionId, @revisionJson,
           @sourceStartEntry, @sourceEndEntry,
           @status, @priority, @createdAt, @updatedAt
         )`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        sessionId: input.sessionId,
        revisionJson: JSON.stringify(input.revision),
        sourceStartEntry: input.sourceStartEntry ?? null,
        sourceEndEntry: input.sourceEndEntry ?? null,
        status: initialStatus,
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
      });
    return this.get(input.id) as MemoryBatch;
  }

  get(id: string): MemoryBatch | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_batches WHERE id = ?")
      .get(id) as BatchRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * 列出待处理批次（provisional / sealed / deferred / failed），
   * 按 priority DESC, created_at ASC 排序。
   */
  listPendingBatches(agentId: string): MemoryBatch[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_batches
         WHERE agent_id = ?
           AND status IN ('provisional', 'sealed', 'deferred', 'failed')
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(agentId) as BatchRow[];
    return rows.map(mapRow);
  }

  listByAgent(
    agentId: string,
    opts?: { status?: MemoryBatchStatus },
  ): MemoryBatch[] {
    const conditions: string[] = ["agent_id = ?"];
    const params: unknown[] = [agentId];
    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_batches
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC`,
      )
      .all(...params) as BatchRow[];
    return rows.map(mapRow);
  }

  markStatus(id: string, status: MemoryBatchStatus): MemoryBatch {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        "UPDATE memory_batches SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, id);
    if (result.changes !== 1) {
      throw new Error(`封存批次不存在: ${id}`);
    }
    return this.get(id) as MemoryBatch;
  }
}
