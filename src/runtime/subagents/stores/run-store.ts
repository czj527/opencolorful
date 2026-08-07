import type Database from "better-sqlite3";
import Value from "typebox/value";

import {
  SUBAGENT_RUN_ACTIVE_STATUSES,
  SubagentResultV1Schema,
  SubagentRunLimitsV1Schema,
  canTransitSubagentRun,
  isSubagentRunTerminal,
  type AgentMessageId,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunLimitsV1,
  type SubagentRunStatus,
  type SubagentSnapshotId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import { ThreadStore } from "./thread-store.js";
import type { SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：RunStore（plans/phase-14.md §7.2 / §15.4 / §16.2 / §16.4）
//
// subagent_runs 是 Run 状态机事实（SQLite 为权威，transcript 不替代）：
// - transit：事务内 compare-and-set，canTransitSubagentRun 校验非法转换，
//   抛 subagent_run_state_conflict；terminal 重复写幂等（已终态返回已有记录）；
// - create：同 Thread 同时最多一个非终态 Run（IMMEDIATE 事务内检查 + ordinal
//   分配），冲突抛 subagent_run_state_conflict；
// - completeRun：终态 + result_json + usage + reason_code + 清 Lease 单事务；
// - startWithSnapshot：queued → starting + snapshot + Runtime Lease（§16.4 #3）；
// - lease_boot_id/lease_holder_id/lease_expires_at：仅持有者可续租/释放
//   （compare-and-set on boot+holder；过期视为 Lease 丢失，续租返回 false）；
// - 所有查询/变更必须携带 SubagentOwnership（§22.1，经 thread join 过滤）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SubagentRunRecord {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ordinal: number;
  readonly status: SubagentRunStatus;
  readonly triggerMessageId: AgentMessageId;
  readonly snapshotId: SubagentSnapshotId | null;
  readonly snapshotJson: string | null;
  readonly limits: SubagentRunLimitsV1;
  readonly result: SubagentResultV1 | null;
  readonly reasonCode: string | null;
  readonly auditPendingJson: string | null;
  readonly currentPhase: string | null;
  readonly currentTool: string | null;
  readonly iterationCount: number;
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly lastActivityAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly leaseBootId: string | null;
  readonly leaseHolderId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSubagentRunInput {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly triggerMessageId: AgentMessageId;
  readonly limits: SubagentRunLimitsV1;
  readonly createdAt: string;
}

export interface TransitRunInput {
  readonly runId: SubagentRunId;
  readonly from: SubagentRunStatus;
  readonly to: SubagentRunStatus;
  readonly reasonCode: string | null;
  readonly now: string;
}

export interface CompleteRunInput {
  readonly runId: SubagentRunId;
  readonly from: SubagentRunStatus;
  readonly to: SubagentRunStatus;
  readonly result: SubagentResultV1 | null;
  readonly reasonCode: string | null;
  readonly usage: SubagentRunUsage | null;
  readonly now: string;
}

export interface StartRunWithSnapshotInput {
  readonly runId: SubagentRunId;
  readonly snapshotId: SubagentSnapshotId;
  readonly snapshotJson: string;
  readonly limits: SubagentRunLimitsV1;
  readonly leaseBootId: string;
  readonly leaseHolderId: string;
  readonly leaseExpiresAt: string;
  readonly now: string;
}

export interface RenewRunLeaseInput {
  readonly runId: SubagentRunId;
  readonly bootId: string;
  readonly holderId: string;
  readonly expiresAt: string;
  readonly now: string;
}

export interface ReleaseRunLeaseInput {
  readonly runId: SubagentRunId;
  readonly bootId: string;
  readonly holderId: string;
  readonly now: string;
}

export interface UpdateRunProgressInput {
  readonly runId: SubagentRunId;
  readonly now: string;
  readonly iterationCount: number | null;
  readonly toolCallCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly currentPhase: string | null;
  readonly currentTool: string | null;
  readonly lastActivityAt: string | null;
}

export interface TransitRunResult {
  readonly run: SubagentRunRecord;
  readonly idempotent: boolean;
}

interface RunRow {
  run_id: SubagentRunId;
  thread_id: SubagentThreadId;
  ordinal: number;
  status: SubagentRunStatus;
  trigger_message_id: AgentMessageId;
  snapshot_id: SubagentSnapshotId | null;
  snapshot_json: string | null;
  limits_json: string;
  result_json: string | null;
  reason_code: string | null;
  audit_pending_json: string | null;
  current_phase: string | null;
  current_tool: string | null;
  iteration_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_activity_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_boot_id: string | null;
  lease_holder_id: string | null;
  lease_expires_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** 活动态 SQL IN 列表（migrations CHECK 与 SUBAGENT_RUN_ACTIVE_STATUSES 一致） */
const ACTIVE_STATUS_IN_LIST = `(${SUBAGENT_RUN_ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ")})`;

function parseLimits(json: string): SubagentRunLimitsV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SubagentStoreError("subagent_operation_failed", "corrupted subagent_runs.limits_json");
  }
  if (!Value.Check(SubagentRunLimitsV1Schema, parsed)) {
    throw new SubagentStoreError("subagent_operation_failed", "invalid subagent_runs.limits_json");
  }
  return parsed as SubagentRunLimitsV1;
}

function parseResult(json: string | null): SubagentResultV1 | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SubagentStoreError("subagent_operation_failed", "corrupted subagent_runs.result_json");
  }
  if (!Value.Check(SubagentResultV1Schema, parsed)) {
    throw new SubagentStoreError("subagent_operation_failed", "invalid subagent_runs.result_json");
  }
  return parsed as SubagentResultV1;
}

function mapRunRow(row: RunRow): SubagentRunRecord {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    ordinal: row.ordinal,
    status: row.status,
    triggerMessageId: row.trigger_message_id,
    snapshotId: row.snapshot_id,
    snapshotJson: row.snapshot_json,
    limits: parseLimits(row.limits_json),
    result: parseResult(row.result_json),
    reasonCode: row.reason_code,
    auditPendingJson: row.audit_pending_json,
    currentPhase: row.current_phase,
    currentTool: row.current_tool,
    iterationCount: row.iteration_count,
    toolCallCount: row.tool_call_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    lastActivityAt: row.last_activity_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseBootId: row.lease_boot_id,
    leaseHolderId: row.lease_holder_id,
    leaseExpiresAt: row.lease_expires_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunStore {
  constructor(
    private readonly database: Database.Database,
    private readonly threadStore: ThreadStore,
  ) {}

  /**
   * 创建 queued Run（§7.4）：IMMEDIATE 事务内校验
   * - Thread 存在且归属匹配（open 才能新建 Run）；
   * - 同一 Thread 同时最多一个非终态 Run（冲突抛 subagent_run_state_conflict）；
   * - 分配 next_run_ordinal（严格递增、重启不重复）；
   * - limits_json 过 TypeBox 校验。
   */
  create(input: CreateSubagentRunInput, ownership: SubagentOwnership): SubagentRunRecord {
    return this.database
      .transaction(() => {
        const thread = this.threadStore.get(input.threadId, ownership);
        if (thread === null) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${input.threadId} not found`);
        }
        if (thread.status !== "open") {
          throw new SubagentStoreError("subagent_thread_state_conflict", `thread ${input.threadId} is not open: new run rejected`);
        }
        if (!Value.Check(SubagentRunLimitsV1Schema, input.limits)) {
          throw new SubagentStoreError("subagent_operation_failed", "invalid run limits");
        }
        const active = this.database
          .prepare(`SELECT 1 FROM subagent_runs WHERE thread_id = ? AND status IN ${ACTIVE_STATUS_IN_LIST} LIMIT 1`)
          .get(input.threadId);
        if (active !== undefined) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `thread ${input.threadId} already has an active (non-terminal) run`,
          );
        }
        const ordinal = this.threadStore.allocateRunOrdinal(input.threadId, ownership);
        this.database
          .prepare(
            `INSERT INTO subagent_runs
              (run_id, thread_id, ordinal, status, trigger_message_id, limits_json, created_at, updated_at)
             VALUES (@runId, @threadId, @ordinal, 'queued', @triggerMessageId, @limitsJson, @createdAt, @createdAt)`,
          )
          .run({
            runId: input.runId,
            threadId: input.threadId,
            ordinal,
            triggerMessageId: input.triggerMessageId,
            limitsJson: JSON.stringify(input.limits),
            createdAt: input.createdAt,
          });
        return this.#loadRun(input.runId);
      })
      .immediate();
  }

  /** 归属过滤查询：存在但归属不匹配抛 subagent_ownership_denied；不存在返回 null */
  get(runId: SubagentRunId, ownership: SubagentOwnership): SubagentRunRecord | null {
    const row = this.#findOwned(runId, ownership);
    if (row !== undefined) return mapRunRow(row);
    const exists = this.database.prepare("SELECT 1 FROM subagent_runs WHERE run_id = ?").get(runId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `subagent run ${runId} belongs to another owner/session`);
    }
    return null;
  }

  listByThread(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.* FROM subagent_runs r
         JOIN subagent_threads t ON t.thread_id = r.thread_id
         WHERE r.thread_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
         ORDER BY r.ordinal ASC`,
      )
      .all(threadId, ownership.ownerAgentId, ownership.parentSessionId) as RunRow[];
    return rows.map(mapRunRow);
  }

  /** 同一 Thread 是否有活动（非终态）Run（§7.2 约束；closeThread/恢复用） */
  hasActiveRun(threadId: SubagentThreadId, ownership: SubagentOwnership): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 FROM subagent_runs r
         JOIN subagent_threads t ON t.thread_id = r.thread_id
         WHERE r.thread_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
           AND r.status IN ${ACTIVE_STATUS_IN_LIST}
         LIMIT 1`,
      )
      .get(threadId, ownership.ownerAgentId, ownership.parentSessionId);
    return row !== undefined;
  }

  /** Thread 当前活动（非终态）Run；无 → null（T5 生命周期联动/取消用） */
  getActiveRunByThread(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentRunRecord | null {
    const row = this.database
      .prepare(
        `SELECT r.* FROM subagent_runs r
         JOIN subagent_threads t ON t.thread_id = r.thread_id
         WHERE r.thread_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
           AND r.status IN ${ACTIVE_STATUS_IN_LIST}
         ORDER BY r.created_at ASC
         LIMIT 1`,
      )
      .get(threadId, ownership.ownerAgentId, ownership.parentSessionId) as RunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  /**
   * T5 启动恢复：系统级扫描全部非终态 Run（queued/starting/running/
   * waiting_for_input/cancelling，§16.5 / §25.6：Server crash 后全部
   * interrupted）。系统操作，不携带调用方归属；返回各 Run 的最小引用 +
   * 归属上下文。不做 JSON 解析（corrupted 行由恢复器逐项聚合诊断，
   * 不阻断整体扫描，§16.5 恢复失败属于基础设施错误）。
   */
  listActiveRunRefsWithOwnership(): Array<{ readonly runId: SubagentRunId; readonly threadId: SubagentThreadId; readonly status: SubagentRunStatus; readonly ownership: SubagentOwnership }> {
    const rows = this.database
      .prepare(
        `SELECT r.run_id, r.thread_id, r.status, t.owner_agent_id, t.parent_session_id
         FROM subagent_runs r
         JOIN subagent_threads t ON t.thread_id = r.thread_id
         WHERE r.status IN ${ACTIVE_STATUS_IN_LIST}
         ORDER BY r.created_at ASC`,
      )
      .all() as Array<{ run_id: SubagentRunId; thread_id: SubagentThreadId; status: SubagentRunStatus; owner_agent_id: string; parent_session_id: string }>;
    return rows.map((row) => ({
      runId: row.run_id,
      threadId: row.thread_id,
      status: row.status,
      ownership: { ownerAgentId: row.owner_agent_id, parentSessionId: row.parent_session_id },
    }));
  }

  /**
   * 状态机 compare-and-set（§7.2）：
   * - 当前状态 === from：canTransitSubagentRun 合法 → 更新；非法抛 subagent_run_state_conflict；
   * - 当前已终态且 === to：幂等返回已有记录（terminal 重复写幂等）；
   * - 其他任何不符：抛 subagent_run_state_conflict。
   * 终态写入同时清 Runtime Lease 字段（§15.4）并记 finished_at。
   */
  transit(input: TransitRunInput, ownership: SubagentOwnership): TransitRunResult {
    return this.database
      .transaction(() => {
        const current = this.#getOwnedOrThrow(input.runId, ownership);
        if (isSubagentRunTerminal(current.status) && current.status === input.to) {
          return { run: current, idempotent: true };
        }
        if (current.status !== input.from) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `run ${input.runId} status ${current.status} does not match expected ${input.from}`,
          );
        }
        if (!canTransitSubagentRun(input.from, input.to)) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `illegal run transition ${input.from} -> ${input.to} for run ${input.runId}`,
          );
        }
        const terminal = isSubagentRunTerminal(input.to);
        this.database
          .prepare(
            `UPDATE subagent_runs SET
               status = @to,
               reason_code = @reasonCode,
               finished_at = CASE WHEN @terminal THEN @now ELSE finished_at END,
               lease_boot_id = CASE WHEN @terminal THEN NULL ELSE lease_boot_id END,
               lease_holder_id = CASE WHEN @terminal THEN NULL ELSE lease_holder_id END,
               lease_expires_at = CASE WHEN @terminal THEN NULL ELSE lease_expires_at END,
               updated_at = @now,
               revision = revision + 1
             WHERE run_id = @runId`,
          )
          .run({
            to: input.to,
            reasonCode: input.reasonCode,
            terminal: terminal ? 1 : 0,
            now: input.now,
            runId: input.runId,
          });
        return { run: this.#loadRun(input.runId), idempotent: false };
      })
      .immediate();
  }

  /**
   * 终态 + result_json + usage + reason_code 原子写入（§16.4 #4/#5/#7 的 Run 部分）。
   * 语义约束：
   * - to 必须是终态；非法转换/状态不符抛 subagent_run_state_conflict；
   * - succeeded 必须携带 SubagentResultV1（缺省抛 subagent_result_not_reported）；
   * - result 只允许 succeeded/failed（cancelled/timed_out/interrupted/
   *   budget_exhausted 无结构化结果）；result 过 TypeBox 校验；
   * - terminal 重复写幂等返回已有记录。
   */
  completeRun(input: CompleteRunInput, ownership: SubagentOwnership): TransitRunResult {
    return this.database
      .transaction(() => {
        const current = this.#getOwnedOrThrow(input.runId, ownership);
        if (isSubagentRunTerminal(current.status) && current.status === input.to) {
          return { run: current, idempotent: true };
        }
        if (current.status !== input.from) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `run ${input.runId} status ${current.status} does not match expected ${input.from}`,
          );
        }
        if (!isSubagentRunTerminal(input.to)) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `completeRun requires a terminal status, got ${input.to}`,
          );
        }
        if (!canTransitSubagentRun(input.from, input.to)) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `illegal run transition ${input.from} -> ${input.to} for run ${input.runId}`,
          );
        }
        if (input.to === "succeeded" && input.result === null) {
          throw new SubagentStoreError("subagent_result_not_reported", `run ${input.runId} succeeded without a SubagentResultV1`);
        }
        if (input.result !== null && input.to !== "succeeded" && input.to !== "failed") {
          throw new SubagentStoreError(
            "subagent_operation_failed",
            `run ${input.runId} terminal status ${input.to} cannot carry a SubagentResultV1`,
          );
        }
        if (input.result !== null && !Value.Check(SubagentResultV1Schema, input.result)) {
          throw new SubagentStoreError("subagent_operation_failed", `invalid SubagentResultV1 for run ${input.runId}`);
        }
        const usage = input.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        this.database
          .prepare(
            `UPDATE subagent_runs SET
               status = @to,
               result_json = @resultJson,
               reason_code = @reasonCode,
               finished_at = @now,
               input_tokens = @inputTokens,
               output_tokens = @outputTokens,
               total_tokens = @totalTokens,
               lease_boot_id = NULL,
               lease_holder_id = NULL,
               lease_expires_at = NULL,
               updated_at = @now,
               revision = revision + 1
             WHERE run_id = @runId`,
          )
          .run({
            to: input.to,
            resultJson: input.result === null ? null : JSON.stringify(input.result),
            reasonCode: input.reasonCode,
            now: input.now,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            runId: input.runId,
          });
        return { run: this.#loadRun(input.runId), idempotent: false };
      })
      .immediate();
  }

  /**
   * queued → starting + snapshot + Runtime Lease 单事务（§16.4 #3，§15.4）。
   * only when queued；snapshot_json 原样透传（T3/T4 冻结 EffectiveSnapshot 的
   * JSON 序列化），limits_json 过 TypeBox 校验；started_at 首次写入。
   */
  startWithSnapshot(input: StartRunWithSnapshotInput, ownership: SubagentOwnership): SubagentRunRecord {
    return this.database
      .transaction(() => {
        const current = this.#getOwnedOrThrow(input.runId, ownership);
        if (current.status !== "queued") {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `run ${input.runId} cannot start: expected queued, got ${current.status}`,
          );
        }
        if (!Value.Check(SubagentRunLimitsV1Schema, input.limits)) {
          throw new SubagentStoreError("subagent_operation_failed", "invalid run limits");
        }
        this.database
          .prepare(
            `UPDATE subagent_runs SET
               status = 'starting',
               snapshot_id = @snapshotId,
               snapshot_json = @snapshotJson,
               limits_json = @limitsJson,
               lease_boot_id = @leaseBootId,
               lease_holder_id = @leaseHolderId,
               lease_expires_at = @leaseExpiresAt,
               started_at = COALESCE(started_at, @now),
               updated_at = @now,
               revision = revision + 1
             WHERE run_id = @runId`,
          )
          .run({
            runId: input.runId,
            snapshotId: input.snapshotId,
            snapshotJson: input.snapshotJson,
            limitsJson: JSON.stringify(input.limits),
            leaseBootId: input.leaseBootId,
            leaseHolderId: input.leaseHolderId,
            leaseExpiresAt: input.leaseExpiresAt,
            now: input.now,
          });
        return this.#loadRun(input.runId);
      })
      .immediate();
  }

  /** 仅持有者可续租（compare-and-set on boot+holder）；Lease 已过期视为丢失，返回 false */
  renewLease(input: RenewRunLeaseInput, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_runs SET
           lease_expires_at = @expiresAt,
           updated_at = @now,
           revision = revision + 1
         WHERE run_id = @runId
           AND lease_boot_id = @bootId
           AND lease_holder_id = @holderId
           AND lease_expires_at > @now
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_runs.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({
        runId: input.runId,
        bootId: input.bootId,
        holderId: input.holderId,
        expiresAt: input.expiresAt,
        now: input.now,
        owner: ownership.ownerAgentId,
        session: ownership.parentSessionId,
      });
    return result.changes > 0;
  }

  /** 仅持有者可释放（compare-and-set on boot+holder）；返回是否释放成功 */
  releaseLease(input: ReleaseRunLeaseInput, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_runs SET
           lease_boot_id = NULL,
           lease_holder_id = NULL,
           lease_expires_at = NULL,
           updated_at = @now,
           revision = revision + 1
         WHERE run_id = @runId
           AND lease_boot_id = @bootId
           AND lease_holder_id = @holderId
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_runs.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({
        runId: input.runId,
        bootId: input.bootId,
        holderId: input.holderId,
        now: input.now,
        owner: ownership.ownerAgentId,
        session: ownership.parentSessionId,
      });
    return result.changes > 0;
  }

  /**
   * 进度/用量字段更新（§15.3 / §15.5）：提供即覆盖（COALESCE 语义，null = 保留原值），
   * updated_at + revision 推进。Run 不存在返回 null。
   */
  updateProgress(input: UpdateRunProgressInput, ownership: SubagentOwnership): SubagentRunRecord | null {
    return this.database
      .transaction(() => {
        const current = this.#findOwned(input.runId, ownership);
        if (current === undefined) {
          this.get(input.runId, ownership);
          return null;
        }
        this.database
          .prepare(
            `UPDATE subagent_runs SET
               iteration_count = COALESCE(@iterationCount, iteration_count),
               tool_call_count = COALESCE(@toolCallCount, tool_call_count),
               input_tokens = COALESCE(@inputTokens, input_tokens),
               output_tokens = COALESCE(@outputTokens, output_tokens),
               total_tokens = COALESCE(@totalTokens, total_tokens),
               current_phase = COALESCE(@currentPhase, current_phase),
               current_tool = COALESCE(@currentTool, current_tool),
               last_activity_at = COALESCE(@lastActivityAt, last_activity_at),
               updated_at = @now,
               revision = revision + 1
             WHERE run_id = @runId`,
          )
          .run({
            runId: input.runId,
            iterationCount: input.iterationCount,
            toolCallCount: input.toolCallCount,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            totalTokens: input.totalTokens,
            currentPhase: input.currentPhase,
            currentTool: input.currentTool,
            lastActivityAt: input.lastActivityAt,
            now: input.now,
          });
        return this.#loadRun(input.runId);
      })
      .immediate();
  }

  /** T5 恢复器补写 auditPending 证据（§19.3）；原始 JSON 透传，不解析 */
  updateAuditPending(runId: SubagentRunId, ownership: SubagentOwnership, auditPendingJson: string | null): void {
    this.database
      .transaction(() => {
        this.#getOwnedOrThrow(runId, ownership);
        const result = this.database
          .prepare(
            `UPDATE subagent_runs SET
               audit_pending_json = @json,
               updated_at = @now,
               revision = revision + 1
             WHERE run_id = @runId`,
          )
          .run({ json: auditPendingJson, now: new Date().toISOString(), runId });
        if (result.changes !== 1) {
          throw new SubagentStoreError("subagent_not_found", `subagent run ${runId} not found`);
        }
      })
      .immediate();
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  #findOwned(runId: SubagentRunId, ownership: SubagentOwnership): RunRow | undefined {
    return this.database
      .prepare(
        `SELECT r.* FROM subagent_runs r
         JOIN subagent_threads t ON t.thread_id = r.thread_id
         WHERE r.run_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?`,
      )
      .get(runId, ownership.ownerAgentId, ownership.parentSessionId) as RunRow | undefined;
  }

  #getOwnedOrThrow(runId: SubagentRunId, ownership: SubagentOwnership): SubagentRunRecord {
    const row = this.#findOwned(runId, ownership);
    if (row !== undefined) return mapRunRow(row);
    const exists = this.database.prepare("SELECT 1 FROM subagent_runs WHERE run_id = ?").get(runId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `subagent run ${runId} belongs to another owner/session`);
    }
    throw new SubagentStoreError("subagent_not_found", `subagent run ${runId} not found`);
  }

  #loadRun(runId: SubagentRunId): SubagentRunRecord {
    const row = this.database.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) {
      throw new SubagentStoreError("subagent_not_found", `subagent run ${runId} not found`);
    }
    return mapRunRow(row);
  }
}
