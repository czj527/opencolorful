import type Database from "better-sqlite3";
import Value from "typebox/value";

import {
  SubagentCapabilitySummarySchema,
  type SubagentCapabilitySummary,
  type SubagentModelSource,
  type SubagentThreadId,
  type SubagentThreadStatus,
} from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import type { SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：ThreadStore（plans/phase-14.md §7.1 / §16.2 / §16.4）
//
// subagent_threads 是 Thread 生命周期/模型/能力 ceiling 事实（SQLite 权威）：
// - status 转换 open → closing → closed，非法转换抛 subagent_thread_state_conflict；
// - next_message_sequence / next_run_ordinal 由 Thread 行持有，在调用方事务内
//   （或本方法自开的事务内）SELECT + UPDATE 分配，并发严格递增、重启不重复；
// - 所有查询/变更必须携带 SubagentOwnership（§22.1），归属不匹配抛
//   subagent_ownership_denied；
// - capability_ceiling_json 写入/读取均过 TypeBox 校验（DB JSON 显式解析）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentThreadRecord {
  readonly threadId: SubagentThreadId;
  readonly ownerAgentId: string;
  readonly parentSessionId: string;
  readonly createdFromTurnId: string | null;
  readonly title: string;
  readonly status: SubagentThreadStatus;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly modelSource: SubagentModelSource;
  readonly thinkingLevel: string;
  readonly workspaceCwd: string;
  readonly capabilityCeiling: SubagentCapabilitySummary;
  readonly contextPacketHash: string;
  readonly nextMessageSequence: number;
  readonly nextRunOrdinal: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly auditPendingJson: string | null;
}

export interface CreateSubagentThreadInput {
  readonly threadId: SubagentThreadId;
  readonly ownerAgentId: string;
  readonly parentSessionId: string;
  readonly createdFromTurnId: string | null;
  readonly title: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly modelSource: SubagentModelSource;
  readonly thinkingLevel: string;
  readonly workspaceCwd: string;
  readonly capabilityCeiling: SubagentCapabilitySummary;
  readonly contextPacketHash: string;
  readonly createdAt: string;
}

interface ThreadRow {
  thread_id: SubagentThreadId;
  owner_agent_id: string;
  parent_session_id: string;
  created_from_turn_id: string | null;
  title: string;
  status: SubagentThreadStatus;
  model_provider_id: string;
  model_id: string;
  model_source: SubagentModelSource;
  thinking_level: string;
  workspace_cwd: string;
  capability_ceiling_json: string;
  context_packet_hash: string;
  next_message_sequence: number;
  next_run_ordinal: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  closed_at: string | null;
  close_reason: string | null;
  audit_pending_json: string | null;
}

function parseCapabilityCeiling(json: string): SubagentCapabilitySummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SubagentStoreError("subagent_operation_failed", "corrupted subagent_threads.capability_ceiling_json");
  }
  if (!Value.Check(SubagentCapabilitySummarySchema, parsed)) {
    throw new SubagentStoreError("subagent_operation_failed", "invalid subagent_threads.capability_ceiling_json");
  }
  return parsed as SubagentCapabilitySummary;
}

function mapThreadRow(row: ThreadRow): SubagentThreadRecord {
  return {
    threadId: row.thread_id,
    ownerAgentId: row.owner_agent_id,
    parentSessionId: row.parent_session_id,
    createdFromTurnId: row.created_from_turn_id,
    title: row.title,
    status: row.status,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    modelSource: row.model_source,
    thinkingLevel: row.thinking_level,
    workspaceCwd: row.workspace_cwd,
    capabilityCeiling: parseCapabilityCeiling(row.capability_ceiling_json),
    contextPacketHash: row.context_packet_hash,
    nextMessageSequence: row.next_message_sequence,
    nextRunOrdinal: row.next_run_ordinal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    auditPendingJson: row.audit_pending_json,
  };
}

export class ThreadStore {
  constructor(private readonly database: Database.Database) {}

  create(input: CreateSubagentThreadInput): SubagentThreadRecord {
    if (!Value.Check(SubagentCapabilitySummarySchema, input.capabilityCeiling)) {
      throw new SubagentStoreError("subagent_operation_failed", "invalid capability ceiling");
    }
    try {
      this.database
        .prepare(
          `INSERT INTO subagent_threads
            (thread_id, owner_agent_id, parent_session_id, created_from_turn_id, title, status,
             model_provider_id, model_id, model_source, thinking_level, workspace_cwd,
             capability_ceiling_json, context_packet_hash,
             created_at, updated_at, last_activity_at)
           VALUES
            (@threadId, @ownerAgentId, @parentSessionId, @createdFromTurnId, @title, 'open',
             @modelProviderId, @modelId, @modelSource, @thinkingLevel, @workspaceCwd,
             @capabilityCeilingJson, @contextPacketHash,
             @createdAt, @createdAt, @createdAt)`,
        )
        .run({
          threadId: input.threadId,
          ownerAgentId: input.ownerAgentId,
          parentSessionId: input.parentSessionId,
          createdFromTurnId: input.createdFromTurnId,
          title: input.title,
          modelProviderId: input.modelProviderId,
          modelId: input.modelId,
          modelSource: input.modelSource,
          thinkingLevel: input.thinkingLevel,
          workspaceCwd: input.workspaceCwd,
          capabilityCeilingJson: JSON.stringify(input.capabilityCeiling),
          contextPacketHash: input.contextPacketHash,
          createdAt: input.createdAt,
        });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new SubagentStoreError("subagent_operation_failed", `subagent thread ${input.threadId} already exists`);
      }
      throw error;
    }
    return this.#getOwnedOrThrow(input.threadId, {
      ownerAgentId: input.ownerAgentId,
      parentSessionId: input.parentSessionId,
    });
  }

  /**
   * 归属过滤查询：存在但归属不匹配抛 subagent_ownership_denied（§22.1）；
   * 完全不存在返回 null（调用方映射 subagent_not_found）。
   */
  get(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentThreadRecord | null {
    const record = this.#getOwned(threadId, ownership);
    if (record !== null) return record;
    this.#assertNotOwnedByOther(threadId);
    return null;
  }

  listByOwner(ownership: SubagentOwnership, limit = 50): SubagentThreadRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM subagent_threads
         WHERE owner_agent_id = ? AND parent_session_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(ownership.ownerAgentId, ownership.parentSessionId, Math.min(Math.max(limit, 1), 500)) as ThreadRow[];
    return rows.map(mapThreadRow);
  }

  /** open → closing（compare-and-set）；非 open 抛 subagent_thread_state_conflict */
  beginClosing(threadId: SubagentThreadId, ownership: SubagentOwnership, at: string): SubagentThreadRecord {
    return this.database
      .transaction(() => {
        this.#getOwnedOrThrow(threadId, ownership);
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET status = 'closing', updated_at = @at, last_activity_at = @at
             WHERE thread_id = @threadId AND owner_agent_id = @owner AND parent_session_id = @session AND status = 'open'`,
          )
          .run({ threadId, owner: ownership.ownerAgentId, session: ownership.parentSessionId, at });
        if (result.changes === 0) {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} cannot begin closing: not open`);
        }
        return this.#getOwnedOrThrow(threadId, ownership);
      })
      .immediate();
  }

  /** closing → closed（compare-and-set）；非 closing 抛 subagent_thread_state_conflict */
  markClosed(
    threadId: SubagentThreadId,
    ownership: SubagentOwnership,
    at: string,
    closeReason: string | null,
  ): SubagentThreadRecord {
    return this.database
      .transaction(() => {
        this.#getOwnedOrThrow(threadId, ownership);
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET status = 'closed', closed_at = @at, close_reason = @closeReason,
                 updated_at = @at, last_activity_at = @at
             WHERE thread_id = @threadId AND owner_agent_id = @owner AND parent_session_id = @session AND status = 'closing'`,
          )
          .run({ threadId, owner: ownership.ownerAgentId, session: ownership.parentSessionId, at, closeReason });
        if (result.changes === 0) {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} cannot close: not closing`);
        }
        return this.#getOwnedOrThrow(threadId, ownership);
      })
      .immediate();
  }

  /** 更新 last_activity_at / updated_at（§15.3 业务活动时间轴；不用于 Lease 心跳） */
  touchActivity(threadId: SubagentThreadId, ownership: SubagentOwnership, at: string): void {
    this.database
      .transaction(() => {
        this.#getOwnedOrThrow(threadId, ownership);
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET last_activity_at = @at, updated_at = @at
             WHERE thread_id = @threadId AND owner_agent_id = @owner AND parent_session_id = @session`,
          )
          .run({ threadId, owner: ownership.ownerAgentId, session: ownership.parentSessionId, at });
        if (result.changes !== 1) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${threadId} not found`);
        }
      })
      .immediate();
  }

  /**
   * 事务内分配下一条协议 sequence（§8.2 / §16.4 #2）。
   * Thread 行持有 next_message_sequence（DEFAULT 1 = 下一条将分配的值），
   * SELECT + UPDATE 在 IMMEDIATE 事务内原子执行；closed Thread 拒绝分配
   * （只读历史），closing 允许（取消/关闭过程中的终态消息仍需 sequence）。
   */
  allocateMessageSequence(threadId: SubagentThreadId, ownership: SubagentOwnership): number {
    return this.database
      .transaction(() => {
        const thread = this.#getOwnedOrThrow(threadId, ownership);
        if (thread.status === "closed") {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} is closed: read-only`);
        }
        const sequence = thread.nextMessageSequence;
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET next_message_sequence = next_message_sequence + 1
             WHERE thread_id = @threadId AND status IN ('open', 'closing')`,
          )
          .run({ threadId });
        if (result.changes !== 1) {
          // 其他连接在读取与写入之间把 Thread 关掉了（跨连接竞态）
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} is closed: read-only`);
        }
        return sequence;
      })
      .immediate();
  }

  /** 事务内分配下一条 Run ordinal（§7.4）；只有 open Thread 允许新建 Run */
  allocateRunOrdinal(threadId: SubagentThreadId, ownership: SubagentOwnership): number {
    return this.database
      .transaction(() => {
        const thread = this.#getOwnedOrThrow(threadId, ownership);
        if (thread.status !== "open") {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} is not open: new run rejected`);
        }
        const ordinal = thread.nextRunOrdinal;
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET next_run_ordinal = next_run_ordinal + 1
             WHERE thread_id = @threadId AND status = 'open'`,
          )
          .run({ threadId });
        if (result.changes !== 1) {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${threadId} is not open: new run rejected`);
        }
        return ordinal;
      })
      .immediate();
  }

  /** T5 恢复器补写 auditPending 证据（§19.3）；原始 JSON 透传，不解析 */
  updateAuditPending(threadId: SubagentThreadId, ownership: SubagentOwnership, auditPendingJson: string | null): void {
    this.database
      .transaction(() => {
        this.#getOwnedOrThrow(threadId, ownership);
        const result = this.database
          .prepare(
            `UPDATE subagent_threads
             SET audit_pending_json = @json, updated_at = @now
             WHERE thread_id = @threadId AND owner_agent_id = @owner AND parent_session_id = @session`,
          )
          .run({ json: auditPendingJson, now: new Date().toISOString(), threadId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
        if (result.changes !== 1) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${threadId} not found`);
        }
      })
      .immediate();
  }

  /**
   * T5 系统级读取（启动恢复/生命周期联动）：不携带调用方归属，
   * 从行自身返回 owner/session。仅限平台内部系统流程使用；不存在返回 null。
   */
  getSystem(threadId: SubagentThreadId): SubagentThreadRecord | null {
    const row = this.database.prepare("SELECT * FROM subagent_threads WHERE thread_id = ?").get(threadId) as ThreadRow | undefined;
    return row === undefined ? null : mapThreadRow(row);
  }

  /**
   * T5 启动恢复：扫描全部 closing 状态 Thread（§7.1：closing 表示取消中；
   * 崩溃后恢复器把无活动 Run 的 closing 终态化为 closed，避免卡在 closing）。
   */
  listClosingWithOwnership(): Array<{ readonly thread: SubagentThreadRecord; readonly ownership: SubagentOwnership }> {
    const rows = this.database
      .prepare("SELECT * FROM subagent_threads WHERE status = 'closing' ORDER BY updated_at ASC")
      .all() as ThreadRow[];
    return rows.map((row) => ({
      thread: mapThreadRow(row),
      ownership: { ownerAgentId: row.owner_agent_id, parentSessionId: row.parent_session_id },
    }));
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  /** 归属过滤读取；存在但归属不匹配 → 返回 undefined（由调用方判定） */
  #getOwned(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentThreadRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM subagent_threads
         WHERE thread_id = ? AND owner_agent_id = ? AND parent_session_id = ?`,
      )
      .get(threadId, ownership.ownerAgentId, ownership.parentSessionId) as ThreadRow | undefined;
    return row === undefined ? null : mapThreadRow(row);
  }

  /** 行存在但归属不匹配 → 抛 subagent_ownership_denied；不存在则静默返回 */
  #assertNotOwnedByOther(threadId: SubagentThreadId): void {
    const exists = this.database.prepare("SELECT 1 FROM subagent_threads WHERE thread_id = ?").get(threadId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `subagent thread ${threadId} belongs to another owner/session`);
    }
  }

  #getOwnedOrThrow(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentThreadRecord {
    const record = this.#getOwned(threadId, ownership);
    if (record !== null) return record;
    this.#assertNotOwnedByOther(threadId);
    throw new SubagentStoreError("subagent_not_found", `subagent thread ${threadId} not found`);
  }
}

function isSqliteConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
