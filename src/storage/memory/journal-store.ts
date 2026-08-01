import type Database from "better-sqlite3";
import type {
  MemoryJournalActor,
  MemoryJournalIntent,
  MemoryJournalIntentType,
  MemoryJournalStatus,
  MemoryJournalTargetType,
} from "../../contracts/memory.js";

interface JournalRow {
  id: string;
  agent_id: string;
  actor: string;
  intent_type: string;
  target_type: string;
  target_id: string | null;
  payload: string;
  priority: number;
  status: string;
  created_at: string;
  applied_at: string | null;
}

function mapRow(row: JournalRow): MemoryJournalIntent {
  return {
    id: row.id,
    agentId: row.agent_id,
    actor: row.actor as MemoryJournalActor,
    intentType: row.intent_type as MemoryJournalIntentType,
    targetType: row.target_type as MemoryJournalTargetType,
    ...(row.target_id !== null ? { targetId: row.target_id } : {}),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    ...(row.priority !== 0 ? { priority: row.priority } : {}),
    status: row.status as MemoryJournalStatus,
    createdAt: row.created_at,
    ...(row.applied_at !== null ? { appliedAt: row.applied_at } : {}),
  };
}

export interface MemoryJournalIntentInput {
  id: string;
  agentId: string;
  actor: MemoryJournalActor;
  intentType: MemoryJournalIntentType;
  targetType: MemoryJournalTargetType;
  targetId?: string;
  payload: Record<string, unknown>;
  /** 高优先级（v7 列，默认 0） */
  priority?: number;
}

export class MemoryJournalStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 追加一条记忆意图，初始 status='pending'。
   * append-only 语义：不提供修改 payload 的方法。
   */
  appendIntent(input: MemoryJournalIntentInput): MemoryJournalIntent {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO memory_journal
          (id, agent_id, actor, intent_type, target_type, target_id,
           payload, priority, status, created_at)
         VALUES (
           @id, @agentId, @actor, @intentType, @targetType, @targetId,
           @payload, @priority, 'pending', @createdAt
         )`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        actor: input.actor,
        intentType: input.intentType,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        payload: JSON.stringify(input.payload),
        priority: input.priority ?? 0,
        createdAt,
      });
    return this.get(input.id) as MemoryJournalIntent;
  }

  /**
   * 追加一条系统意图，允许指定初始 status（如 pin 即时应用留痕 status='applied' + applied_at）。
   */
  appendSystemIntent(
    input: MemoryJournalIntentInput & {
      status: MemoryJournalStatus;
      appliedAt?: string;
    },
  ): MemoryJournalIntent {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO memory_journal
          (id, agent_id, actor, intent_type, target_type, target_id,
           payload, priority, status, created_at, applied_at)
         VALUES (
           @id, @agentId, @actor, @intentType, @targetType, @targetId,
           @payload, @priority, @status, @createdAt, @appliedAt
         )`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        actor: input.actor,
        intentType: input.intentType,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        payload: JSON.stringify(input.payload),
        priority: input.priority ?? 0,
        status: input.status,
        createdAt,
        appliedAt: input.appliedAt ?? null,
      });
    return this.get(input.id) as MemoryJournalIntent;
  }

  get(id: string): MemoryJournalIntent | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_journal WHERE id = ?")
      .get(id) as JournalRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listPending(agentId: string): MemoryJournalIntent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_journal
         WHERE agent_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(agentId) as JournalRow[];
    return rows.map(mapRow);
  }

  listByAgent(
    agentId: string,
    opts?: {
      status?: MemoryJournalStatus;
      intentType?: MemoryJournalIntentType;
      limit?: number;
    },
  ): MemoryJournalIntent[] {
    const conditions: string[] = ["agent_id = ?"];
    const params: unknown[] = [agentId];

    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.intentType) {
      conditions.push("intent_type = ?");
      params.push(opts.intentType);
    }

    const limit = opts?.limit ?? 50;

    const rows = this.database
      .prepare(
        `SELECT * FROM memory_journal
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as JournalRow[];
    return rows.map(mapRow);
  }

  markStatus(
    id: string,
    status: MemoryJournalStatus,
    appliedAt?: string,
  ): MemoryJournalIntent {
    const effectiveAppliedAt =
      appliedAt ?? (status === "applied" ? new Date().toISOString() : null);
    const result = this.database
      .prepare(
        `UPDATE memory_journal SET status = ?, applied_at = ? WHERE id = ?`,
      )
      .run(status, effectiveAppliedAt, id);
    if (result.changes !== 1) {
      throw new Error(`记忆意图不存在: ${id}`);
    }
    return this.get(id) as MemoryJournalIntent;
  }

  /**
   * 返回 suppress/forget 类意图（rebuild 过滤用）。
   * 只返回已应用的（applied），避免重建时被 pending/revoked 意图误过滤。
   */
  listSuppressions(agentId: string): MemoryJournalIntent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_journal
         WHERE agent_id = ?
           AND intent_type IN ('suppress', 'forget')
           AND status = 'applied'
         ORDER BY created_at ASC`,
      )
      .all(agentId) as JournalRow[];
    return rows.map(mapRow);
  }
}
