import type Database from "better-sqlite3";
import { Type } from "typebox";
import Value from "typebox/value";

import {
  AgentMessageEnvelopeV1Schema,
  SUBAGENT_MESSAGE_TYPE_PERMISSIONS,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type SubagentDeliveryMode,
  type SubagentMessageType,
  type SubagentRecipientKind,
  type SubagentRunId,
  type SubagentSenderKind,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import { ThreadStore } from "./thread-store.js";
import { SUBAGENT_MESSAGE_DELIVERY_STATUSES, type SubagentMessageDeliveryStatus, type SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：MessageStore（plans/phase-14.md §8.2 / §16.2 / §16.4 #2）
//
// subagent_messages 是父子协议 Envelope 与严格 sequence 事实（store-first）：
// - Envelope 写入前 TypeBox 完整校验（含 future version 拒绝：schema 的
//   version: Type.Literal(1) 天然拒绝）；sequence 由调用方省略，Store 在
//   Thread 行事务内分配后补全，再整体校验；
// - sender × messageType 权限（SUBAGENT_MESSAGE_TYPE_PERMISSIONS，§8.3）；
// - contextId/taskId 必须与 thread/run 一致（§22.1 fail-closed）；
// - messageId 幂等：重复写入返回原记录，不重复分配 sequence、不重复副作用；
// - delivery_status 流转 queued → delivering → delivered / failed（幂等）；
// - 读取时对 envelope_json 重新过 TypeBox 校验（拒绝 future/corrupted）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentMessageRecord {
  readonly messageId: AgentMessageId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly sequence: number;
  readonly envelope: AgentMessageEnvelopeV1;
  readonly messageType: SubagentMessageType;
  readonly senderKind: SubagentSenderKind;
  readonly recipientKind: SubagentRecipientKind;
  readonly deliveryMode: SubagentDeliveryMode;
  readonly deliveryStatus: SubagentMessageDeliveryStatus;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface AppendMessageInput {
  /** 调用方不提供 sequence；Store 在 Thread 行事务内分配并补全 */
  readonly envelope: Omit<AgentMessageEnvelopeV1, "sequence">;
  readonly ownership: SubagentOwnership;
  readonly deliveryStatus?: SubagentMessageDeliveryStatus;
  readonly createdAt: string;
}

export interface AppendMessageResult {
  readonly message: SubagentMessageRecord;
  readonly idempotent: boolean;
}

export interface ListMessagesOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

interface MessageRow {
  message_id: AgentMessageId;
  thread_id: SubagentThreadId;
  run_id: SubagentRunId;
  sequence: number;
  envelope_json: string;
  message_type: SubagentMessageType;
  sender_kind: SubagentSenderKind;
  recipient_kind: SubagentRecipientKind;
  delivery_mode: SubagentDeliveryMode;
  delivery_status: SubagentMessageDeliveryStatus;
  consumed_at: string | null;
  created_at: string;
}

/** 无 sequence 的输入校验 schema（完整 Envelope 在分配后再次校验） */
const ENVELOPE_INPUT_SCHEMA = Type.Omit(AgentMessageEnvelopeV1Schema, ["sequence"]);

function parseEnvelope(json: string): AgentMessageEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SubagentStoreError("subagent_operation_failed", "corrupted subagent_messages.envelope_json");
  }
  if (!Value.Check(AgentMessageEnvelopeV1Schema, parsed)) {
    throw new SubagentStoreError("subagent_operation_failed", "invalid or future-version envelope_json in subagent_messages");
  }
  return parsed as AgentMessageEnvelopeV1;
}

function mapMessageRow(row: MessageRow): SubagentMessageRecord {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    runId: row.run_id,
    sequence: row.sequence,
    envelope: parseEnvelope(row.envelope_json),
    messageType: row.message_type,
    senderKind: row.sender_kind,
    recipientKind: row.recipient_kind,
    deliveryMode: row.delivery_mode,
    deliveryStatus: row.delivery_status,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export class MessageStore {
  constructor(
    private readonly database: Database.Database,
    private readonly threadStore: ThreadStore,
  ) {}

  /**
   * store-first 写入（§8.2 / §16.4 #2）：
   * 1. 无 sequence 的 Envelope 过 TypeBox 校验（含消息权限），非法拒绝；
   * 2. messageId 幂等：已存在直接返回原记录；
   * 3. 事务内：Thread 归属/状态检查 → Thread 行分配 sequence → 补全后
   *    完整 Envelope 再校验 → 插入（线程级严格单调、重启不重复）。
   */
  append(input: AppendMessageInput): AppendMessageResult {
    // 通过局部 unknown 校验，避免 Value.Check 的 type-guard 把 input.envelope
    // 收窄为 TypeBox Omit schema 的 Static 推导（含 as never map-Union 时
    // Static 为 never，见 T1 经验：手动类型替代 Static）
    const candidate: unknown = input.envelope;
    if (!Value.Check(ENVELOPE_INPUT_SCHEMA, candidate)) {
      throw new SubagentStoreError("subagent_operation_failed", "invalid AgentMessageEnvelopeV1 (missing required fields, future version, or over-limit)");
    }
    const allowedSenders = SUBAGENT_MESSAGE_TYPE_PERMISSIONS[input.envelope.messageType];
    if (!allowedSenders.includes(input.envelope.sender.kind)) {
      throw new SubagentStoreError(
        "subagent_operation_failed",
        `messageType ${input.envelope.messageType} not allowed for sender kind ${input.envelope.sender.kind} (SUBAGENT_MESSAGE_TYPE_PERMISSIONS)`,
      );
    }

    const existing = this.#findOwned(input.envelope.messageId, input.ownership);
    if (existing !== undefined) {
      return { message: mapMessageRow(existing), idempotent: true };
    }
    this.#assertMessageIdNotOwnedByOther(input.envelope.messageId, input.ownership);

    const deliveryStatus = input.deliveryStatus ?? "queued";
    if (!(SUBAGENT_MESSAGE_DELIVERY_STATUSES as readonly string[]).includes(deliveryStatus)) {
      throw new SubagentStoreError("subagent_operation_failed", `invalid delivery status ${deliveryStatus}`);
    }

    return this.database
      .transaction(() => {
        const thread = this.threadStore.get(input.envelope.contextId, input.ownership);
        if (thread === null) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${input.envelope.contextId} not found`);
        }
        if (thread.status === "closed") {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${input.envelope.contextId} is closed: read-only`);
        }
        const runRow = this.database
          .prepare("SELECT thread_id FROM subagent_runs WHERE run_id = ?")
          .get(input.envelope.taskId) as { thread_id: SubagentThreadId } | undefined;
        if (runRow === undefined) {
          throw new SubagentStoreError("subagent_not_found", `subagent run ${input.envelope.taskId} not found`);
        }
        if (runRow.thread_id !== input.envelope.contextId) {
          throw new SubagentStoreError(
            "subagent_operation_failed",
            `envelope context/task mismatch: taskId ${input.envelope.taskId} belongs to thread ${runRow.thread_id}, not ${input.envelope.contextId}`,
          );
        }
        const sequence = this.threadStore.allocateMessageSequence(input.envelope.contextId, input.ownership);
        const fullEnvelope: AgentMessageEnvelopeV1 = { ...input.envelope, sequence };
        if (!Value.Check(AgentMessageEnvelopeV1Schema, fullEnvelope)) {
          throw new SubagentStoreError("subagent_operation_failed", "invalid AgentMessageEnvelopeV1 after sequence assignment");
        }
        try {
          this.database
            .prepare(
              `INSERT INTO subagent_messages
                (message_id, thread_id, run_id, sequence, envelope_json,
                 message_type, sender_kind, recipient_kind, delivery_mode, delivery_status, consumed_at, created_at)
               VALUES
                (@messageId, @threadId, @runId, @sequence, @envelopeJson,
                 @messageType, @senderKind, @recipientKind, @deliveryMode, @deliveryStatus, NULL, @createdAt)`,
            )
            .run({
              messageId: fullEnvelope.messageId,
              threadId: fullEnvelope.contextId,
              runId: fullEnvelope.taskId,
              sequence: fullEnvelope.sequence,
              envelopeJson: JSON.stringify(fullEnvelope),
              messageType: fullEnvelope.messageType,
              senderKind: fullEnvelope.sender.kind,
              recipientKind: fullEnvelope.recipient.kind,
              deliveryMode: fullEnvelope.deliveryMode,
              deliveryStatus,
              createdAt: input.createdAt,
            });
        } catch (error) {
          if (error instanceof Error) {
            const maybe = error as { code?: unknown };
            if (typeof maybe.code === "string" && maybe.code.startsWith("SQLITE_CONSTRAINT")) {
              throw new SubagentStoreError("subagent_operation_failed", `message insert conflict for ${fullEnvelope.messageId}`);
            }
          }
          throw error;
        }
        return { message: this.#loadMessage(fullEnvelope.messageId), idempotent: false };
      })
      .immediate();
  }
  /** 归属过滤查询：存在但归属不匹配抛 subagent_ownership_denied；不存在返回 null */
  get(messageId: AgentMessageId, ownership: SubagentOwnership): SubagentMessageRecord | null {
    const row = this.#findOwned(messageId, ownership);
    if (row !== undefined) return mapMessageRow(row);
    this.#assertMessageIdNotOwnedByOther(messageId, ownership);
    return null;
  }

  /** Thread 内消息按 sequence 升序（inspect/transcript 用）；严格归属过滤 */
  listByThread(threadId: SubagentThreadId, ownership: SubagentOwnership, options?: ListMessagesOptions): SubagentMessageRecord[] {
    const conditions = ["m.thread_id = @threadId", "t.owner_agent_id = @owner", "t.parent_session_id = @session"];
    const params: Record<string, unknown> = {
      threadId,
      owner: ownership.ownerAgentId,
      session: ownership.parentSessionId,
    };
    if (options?.afterSequence !== undefined) {
      conditions.push("m.sequence > @afterSequence");
      params.afterSequence = options.afterSequence;
    }
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    params.limit = limit;
    const rows = this.database
      .prepare(
        `SELECT m.* FROM subagent_messages m
         JOIN subagent_threads t ON t.thread_id = m.thread_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.sequence ASC
         LIMIT @limit`,
      )
      .all(params) as MessageRow[];
    return rows.map(mapMessageRow);
  }

  listByRun(runId: SubagentRunId, ownership: SubagentOwnership): SubagentMessageRecord[] {
    const rows = this.database
      .prepare(
        `SELECT m.* FROM subagent_messages m
         JOIN subagent_threads t ON t.thread_id = m.thread_id
         WHERE m.run_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
         ORDER BY m.sequence ASC`,
      )
      .all(runId, ownership.ownerAgentId, ownership.parentSessionId) as MessageRow[];
    return rows.map(mapMessageRow);
  }

  /** queued → delivering；已 delivering/delivered 幂等返回 true */
  markDelivering(messageId: AgentMessageId, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_messages SET delivery_status = 'delivering'
         WHERE message_id = @messageId AND delivery_status = 'queued'
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_messages.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({ messageId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    const current = this.#getOwnedOrThrow(messageId, ownership);
    return current.deliveryStatus === "delivering" || current.deliveryStatus === "delivered";
  }

  /** queued/delivering → delivered（记录 consumed_at）；已 delivered 幂等返回 true */
  markDelivered(messageId: AgentMessageId, ownership: SubagentOwnership, consumedAt: string | null): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_messages
         SET delivery_status = 'delivered', consumed_at = @consumedAt
         WHERE message_id = @messageId AND delivery_status IN ('queued', 'delivering')
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_messages.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({ messageId, consumedAt, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    const current = this.#getOwnedOrThrow(messageId, ownership);
    return current.deliveryStatus === "delivered";
  }

  /** queued/delivering → failed；已 failed 幂等返回 true；已 delivered 返回 false */
  markDeliveryFailed(messageId: AgentMessageId, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_messages SET delivery_status = 'failed'
         WHERE message_id = @messageId AND delivery_status IN ('queued', 'delivering')
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_messages.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({ messageId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    if (result.changes > 0) return true;
    const current = this.#getOwnedOrThrow(messageId, ownership);
    return current.deliveryStatus === "failed";
  }

  /**
   * T5 Dispatcher 重试/启动恢复：未结算的父 → 子方向消息
   * （recipient=subagent 的 task/steer/cancel，§8.2：投递失败不删除记录，
   * Delivery Coordinator 可重试）。系统级扫描，返回各消息的归属上下文。
   */
  listUndeliveredToSubagentWithOwnership(limit = 200): Array<{ readonly message: SubagentMessageRecord; readonly ownership: SubagentOwnership }> {
    const rows = this.database
      .prepare(
        `SELECT m.*, t.owner_agent_id AS owner_agent_id, t.parent_session_id AS parent_session_id
         FROM subagent_messages m
         JOIN subagent_threads t ON t.thread_id = m.thread_id
         WHERE m.recipient_kind = 'subagent'
           AND m.delivery_status IN ('queued', 'delivering')
         ORDER BY m.sequence ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 1000)) as Array<MessageRow & { owner_agent_id: string; parent_session_id: string }>;
    return rows.map((row) => ({
      message: mapMessageRow(row),
      ownership: { ownerAgentId: row.owner_agent_id, parentSessionId: row.parent_session_id },
    }));
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  #findOwned(messageId: AgentMessageId, ownership: SubagentOwnership): MessageRow | undefined {
    return this.database
      .prepare(
        `SELECT m.* FROM subagent_messages m
         JOIN subagent_threads t ON t.thread_id = m.thread_id
         WHERE m.message_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?`,
      )
      .get(messageId, ownership.ownerAgentId, ownership.parentSessionId) as MessageRow | undefined;
  }

  #assertMessageIdNotOwnedByOther(messageId: AgentMessageId, ownership: SubagentOwnership): void {
    const exists = this.database.prepare("SELECT 1 FROM subagent_messages WHERE message_id = ?").get(messageId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `message ${messageId} belongs to another owner/session`);
    }
  }

  #getOwnedOrThrow(messageId: AgentMessageId, ownership: SubagentOwnership): SubagentMessageRecord {
    const row = this.#findOwned(messageId, ownership);
    if (row !== undefined) return mapMessageRow(row);
    this.#assertMessageIdNotOwnedByOther(messageId, ownership);
    throw new SubagentStoreError("subagent_not_found", `subagent message ${messageId} not found`);
  }

  #loadMessage(messageId: AgentMessageId): SubagentMessageRecord {
    const row = this.database
      .prepare("SELECT * FROM subagent_messages WHERE message_id = ?")
      .get(messageId) as MessageRow | undefined;
    if (row === undefined) {
      throw new SubagentStoreError("subagent_not_found", `subagent message ${messageId} not found`);
    }
    return mapMessageRow(row);
  }
}
