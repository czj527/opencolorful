import type Database from "better-sqlite3";

import {
  PARENT_MAILBOX_NOTIFICATION_KINDS,
  PARENT_MAILBOX_TRIGGER_KINDS,
  type AgentMessageId,
  type ParentMailboxId,
  type ParentMailboxNotificationKind,
  type ParentMailboxStatus,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import type { SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：ParentMailboxStore（plans/phase-14.md §8.4 / §14 / §16.2）
//
// subagent_parent_mailbox 是父 Mailbox 投递状态与幂等事实：
// - UNIQUE(message_id) / UNIQUE(operation_id)：幂等去重；enqueue 重复
//   message_id 返回原记录（§14.3：同一 Mailbox 项只触发一次父 Turn）；
// - status 流转 queued → delivering → delivered / failed，以及
//   suppressed（父 Session 归档/删除时，§14.2）；
// - triggerParentTurn 只允许 PARENT_MAILBOX_TRIGGER_KINDS（started 不唤醒）；
// - attempt_count 每次进入 delivering 递增（重试次数，§14.3 指数退避）；
// - 所有查询/变更携带 SubagentOwnership（本表自带 owner/session 列）。
// ═══════════════════════════════════════════════════════════════

export interface ParentMailboxRecord {
  readonly mailboxId: ParentMailboxId;
  readonly ownerAgentId: string;
  readonly parentSessionId: string;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly messageId: AgentMessageId;
  readonly notificationKind: ParentMailboxNotificationKind;
  readonly status: ParentMailboxStatus;
  readonly triggerParentTurn: boolean;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly lastErrorCode: string | null;
  readonly operationId: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly suppressedAt: string | null;
}

export interface CreateParentMailboxInput {
  readonly mailboxId: ParentMailboxId;
  readonly ownerAgentId: string;
  readonly parentSessionId: string;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly messageId: AgentMessageId;
  readonly notificationKind: ParentMailboxNotificationKind;
  readonly triggerParentTurn: boolean;
  readonly operationId: string;
  readonly createdAt: string;
}

interface MailboxRow {
  mailbox_id: ParentMailboxId;
  owner_agent_id: string;
  parent_session_id: string;
  thread_id: SubagentThreadId;
  run_id: SubagentRunId;
  message_id: AgentMessageId;
  notification_kind: ParentMailboxNotificationKind;
  status: ParentMailboxStatus;
  trigger_parent_turn: number;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  operation_id: string;
  created_at: string;
  delivered_at: string | null;
  suppressed_at: string | null;
}

function mapMailboxRow(row: MailboxRow): ParentMailboxRecord {
  return {
    mailboxId: row.mailbox_id,
    ownerAgentId: row.owner_agent_id,
    parentSessionId: row.parent_session_id,
    threadId: row.thread_id,
    runId: row.run_id,
    messageId: row.message_id,
    notificationKind: row.notification_kind,
    status: row.status,
    triggerParentTurn: row.trigger_parent_turn === 1,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
    operationId: row.operation_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    suppressedAt: row.suppressed_at,
  };
}

export class ParentMailboxStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 严格插入（复合事务 completeRunWithResult 内部使用）：UNIQUE 冲突直接
   * 抛错（外层事务整体回滚，§16.4 #4 原子性），不吞冲突。
   */
  insert(input: CreateParentMailboxInput): ParentMailboxRecord {
    this.#validate(input);
    try {
      this.#insertRow(input);
    } catch (error) {
      if (error instanceof Error) {
        const maybe = error as { code?: unknown };
        if (typeof maybe.code === "string" && maybe.code.startsWith("SQLITE_CONSTRAINT")) {
          throw new SubagentStoreError(
            "subagent_operation_failed",
            `parent mailbox insert conflict (messageId ${input.messageId} or operationId ${input.operationId} already exists)`,
          );
        }
      }
      throw error;
    }
    const row = this.#loadByMessageId(input.messageId);
    if (row === undefined) {
      throw new SubagentStoreError("subagent_operation_failed", `parent mailbox ${input.mailboxId} insert failed`);
    }
    return mapMailboxRow(row);
  }

  /**
   * 幂等入队：UNIQUE(message_id) 冲突返回原记录（§14.3 重放不重复副作用）。
   * 供独立通知（如 started）使用。
   */
  enqueue(input: CreateParentMailboxInput): ParentMailboxRecord {
    this.#validate(input);
    const existing = this.database
      .prepare("SELECT * FROM subagent_parent_mailbox WHERE message_id = ?")
      .get(input.messageId) as MailboxRow | undefined;
    if (existing !== undefined) return mapMailboxRow(existing);
    this.#insertRow(input);
    const row = this.#loadByMessageId(input.messageId);
    if (row === undefined) {
      throw new SubagentStoreError("subagent_operation_failed", `parent mailbox ${input.mailboxId} enqueue failed`);
    }
    return mapMailboxRow(row);
  }

  get(mailboxId: ParentMailboxId, ownership: SubagentOwnership): ParentMailboxRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM subagent_parent_mailbox
         WHERE mailbox_id = ? AND owner_agent_id = ? AND parent_session_id = ?`,
      )
      .get(mailboxId, ownership.ownerAgentId, ownership.parentSessionId) as MailboxRow | undefined;
    if (row !== undefined) return mapMailboxRow(row);
    const exists = this.database.prepare("SELECT 1 FROM subagent_parent_mailbox WHERE mailbox_id = ?").get(mailboxId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `parent mailbox ${mailboxId} belongs to another owner/session`);
    }
    return null;
  }

  getByMessageId(messageId: AgentMessageId, ownership: SubagentOwnership): ParentMailboxRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM subagent_parent_mailbox
         WHERE message_id = ? AND owner_agent_id = ? AND parent_session_id = ?`,
      )
      .get(messageId, ownership.ownerAgentId, ownership.parentSessionId) as MailboxRow | undefined;
    if (row !== undefined) return mapMailboxRow(row);
    const exists = this.database.prepare("SELECT 1 FROM subagent_parent_mailbox WHERE message_id = ?").get(messageId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `parent mailbox message ${messageId} belongs to another owner/session`);
    }
    return null;
  }

  listByThread(threadId: SubagentThreadId, ownership: SubagentOwnership): ParentMailboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM subagent_parent_mailbox
         WHERE thread_id = ? AND owner_agent_id = ? AND parent_session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(threadId, ownership.ownerAgentId, ownership.parentSessionId) as MailboxRow[];
    return rows.map(mapMailboxRow);
  }

  listByRun(runId: SubagentRunId, ownership: SubagentOwnership): ParentMailboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM subagent_parent_mailbox
         WHERE run_id = ? AND owner_agent_id = ? AND parent_session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId, ownership.ownerAgentId, ownership.parentSessionId) as MailboxRow[];
    return rows.map(mapMailboxRow);
  }

  /** 启动恢复/投递扫描：queued + delivering（§14.3：delivering 视为可重试） */
  listPending(parentSessionId: string, ownership: SubagentOwnership, limit = 100): ParentMailboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM subagent_parent_mailbox
         WHERE parent_session_id = ? AND owner_agent_id = ?
           AND status IN ('queued', 'delivering')
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(parentSessionId, ownership.ownerAgentId, Math.min(Math.max(limit, 1), 1000)) as MailboxRow[];
    return rows.map(mapMailboxRow);
  }

  /** queued → delivering，attempt_count + 1（每次投递尝试计数）；已 delivering 幂等返回 true */
  markDelivering(mailboxId: ParentMailboxId, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_parent_mailbox
         SET status = 'delivering', attempt_count = attempt_count + 1
         WHERE mailbox_id = @mailboxId AND status = 'queued'
           AND owner_agent_id = @owner AND parent_session_id = @session`,
      )
      .run({ mailboxId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    return this.#statusIs(mailboxId, ownership, "delivering");
  }

  /** queued/delivering → delivered + delivered_at；已 delivered 幂等返回 true */
  markDelivered(mailboxId: ParentMailboxId, ownership: SubagentOwnership, deliveredAt: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_parent_mailbox
         SET status = 'delivered', delivered_at = @deliveredAt, next_retry_at = NULL
         WHERE mailbox_id = @mailboxId AND status IN ('queued', 'delivering')
           AND owner_agent_id = @owner AND parent_session_id = @session`,
      )
      .run({ mailboxId, deliveredAt, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    return this.#statusIs(mailboxId, ownership, "delivered");
  }

  /** queued/delivering → failed + last_error_code + next_retry_at（§14.3 退避重试）；已 failed 幂等返回 true */
  markFailed(mailboxId: ParentMailboxId, ownership: SubagentOwnership, errorCode: string, nextRetryAt: string | null): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_parent_mailbox
         SET status = 'failed', last_error_code = @errorCode, next_retry_at = @nextRetryAt
         WHERE mailbox_id = @mailboxId AND status IN ('queued', 'delivering')
           AND owner_agent_id = @owner AND parent_session_id = @session`,
      )
      .run({ mailboxId, errorCode, nextRetryAt, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    return this.#statusIs(mailboxId, ownership, "failed");
  }

  /** failed → queued（重试入口）；清除 next_retry_at，保留 last_error_code 供诊断 */
  requeue(mailboxId: ParentMailboxId, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_parent_mailbox
         SET status = 'queued', next_retry_at = NULL
         WHERE mailbox_id = @mailboxId AND status = 'failed'
           AND owner_agent_id = @owner AND parent_session_id = @session`,
      )
      .run({ mailboxId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    return result.changes > 0;
  }

  /** queued/delivering/failed → suppressed + suppressed_at（§14.2 父级归档/删除）；
   *  已 delivered 不允许抑制（投递成功事实不撤销）；已 suppressed 幂等返回 true */
  markSuppressed(mailboxId: ParentMailboxId, ownership: SubagentOwnership, suppressedAt: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_parent_mailbox
         SET status = 'suppressed', suppressed_at = @suppressedAt
         WHERE mailbox_id = @mailboxId AND status IN ('queued', 'delivering', 'failed')
           AND owner_agent_id = @owner AND parent_session_id = @session`,
      )
      .run({ mailboxId, suppressedAt, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    return this.#statusIs(mailboxId, ownership, "suppressed");
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  #validate(input: CreateParentMailboxInput): void {
    if (!(PARENT_MAILBOX_NOTIFICATION_KINDS as readonly string[]).includes(input.notificationKind)) {
      throw new SubagentStoreError("subagent_operation_failed", `invalid mailbox notification kind ${input.notificationKind}`);
    }
    if (input.triggerParentTurn && !(PARENT_MAILBOX_TRIGGER_KINDS as readonly string[]).includes(input.notificationKind)) {
      throw new SubagentStoreError(
        "subagent_operation_failed",
        `notification kind ${input.notificationKind} cannot trigger a parent turn (PARENT_MAILBOX_TRIGGER_KINDS)`,
      );
    }
  }

  #insertRow(input: CreateParentMailboxInput): void {
    this.database
      .prepare(
        `INSERT INTO subagent_parent_mailbox
          (mailbox_id, owner_agent_id, parent_session_id, thread_id, run_id, message_id,
           notification_kind, status, trigger_parent_turn, attempt_count, operation_id, created_at)
         VALUES
          (@mailboxId, @ownerAgentId, @parentSessionId, @threadId, @runId, @messageId,
           @notificationKind, 'queued', @triggerParentTurn, 0, @operationId, @createdAt)`,
      )
      .run({
        mailboxId: input.mailboxId,
        ownerAgentId: input.ownerAgentId,
        parentSessionId: input.parentSessionId,
        threadId: input.threadId,
        runId: input.runId,
        messageId: input.messageId,
        notificationKind: input.notificationKind,
        triggerParentTurn: input.triggerParentTurn ? 1 : 0,
        operationId: input.operationId,
        createdAt: input.createdAt,
      });
  }

  #loadByMessageId(messageId: AgentMessageId): MailboxRow | undefined {
    return this.database
      .prepare("SELECT * FROM subagent_parent_mailbox WHERE message_id = ?")
      .get(messageId) as MailboxRow | undefined;
  }

  #statusIs(mailboxId: ParentMailboxId, ownership: SubagentOwnership, status: ParentMailboxStatus): boolean {
    const row = this.database
      .prepare(
        `SELECT status FROM subagent_parent_mailbox
         WHERE mailbox_id = ? AND owner_agent_id = ? AND parent_session_id = ?`,
      )
      .get(mailboxId, ownership.ownerAgentId, ownership.parentSessionId) as { status: ParentMailboxStatus } | undefined;
    if (row === undefined) {
      // 行存在但归属不匹配 → 与 get 语义一致的 subagent_ownership_denied（§22.1）
      const exists = this.database.prepare("SELECT 1 FROM subagent_parent_mailbox WHERE mailbox_id = ?").get(mailboxId);
      if (exists !== undefined) {
        throw new SubagentStoreError("subagent_ownership_denied", `parent mailbox ${mailboxId} belongs to another owner/session`);
      }
      throw new SubagentStoreError("subagent_not_found", `parent mailbox ${mailboxId} not found`);
    }
    return row.status === status;
  }
}
