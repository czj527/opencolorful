import type Database from "better-sqlite3";

import {
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type ParentMailboxId,
  type ParentMailboxNotificationKind,
  type SubagentCapabilitySummary,
  type SubagentModelSource,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunLimitsV1,
  type SubagentRunStatus,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import type { ParentMailboxRecord } from "./parent-mailbox-store.js";
import { ParentMailboxStore } from "./parent-mailbox-store.js";
import type { SubagentMessageRecord } from "./message-store.js";
import { MessageStore } from "./message-store.js";
import type { SubagentRunRecord, SubagentRunUsage } from "./run-store.js";
import { RunStore } from "./run-store.js";
import type { SubagentThreadRecord } from "./thread-store.js";
import { ThreadStore } from "./thread-store.js";
import type { SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：关键事务（plans/phase-14.md §16.4）
//
// 以下操作必须单个 SQLite 事务（IMMEDIATE）：
// 1. 创建 Thread + 首条 task message + first Run —— createThreadWithFirstRun；
// 4. terminal Run + result + result message + parent mailbox —— completeRunWithResult；
// 6. close Thread + mailbox suppression 标记 —— closeThread。
// 中途任何一步抛错（状态机非法、TypeBox 校验失败、UNIQUE 冲突）整体回滚，
// 不产生半写状态（§22.3：Runtime terminal 写库失败必须阻止后续执行）。
// ═══════════════════════════════════════════════════════════════

export interface CreateThreadWithFirstRunInput {
  readonly thread: {
    readonly threadId: SubagentThreadId;
    readonly title: string;
    readonly modelProviderId: string;
    readonly modelId: string;
    readonly modelSource: SubagentModelSource;
    readonly thinkingLevel: string;
    readonly workspaceCwd: string;
    readonly capabilityCeiling: SubagentCapabilitySummary;
    readonly contextPacketHash: string;
    readonly createdFromTurnId: string | null;
  };
  readonly ownership: SubagentOwnership;
  readonly firstRun: {
    readonly runId: SubagentRunId;
    readonly triggerMessageId: AgentMessageId;
  };
  /** 缺省使用平台默认 Run 限制（SUBAGENT_RUN_LIMITS_DEFAULTS，§15.2） */
  readonly limits?: SubagentRunLimitsV1;
  readonly taskEnvelope: Omit<AgentMessageEnvelopeV1, "sequence">;
  /** created_at / updated_at / last_activity_at 统一时间戳 */
  readonly now: string;
}

export interface CreateThreadWithFirstRunResult {
  readonly thread: SubagentThreadRecord;
  readonly run: SubagentRunRecord;
  readonly message: SubagentMessageRecord;
}

export interface CompleteRunWithResultInput {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  /** Run 当前活动态（CAS from；不匹配抛 subagent_run_state_conflict） */
  readonly from: SubagentRunStatus;
  /** 目标终态（succeeded/failed/cancelled/timed_out/interrupted/budget_exhausted） */
  readonly to: SubagentRunStatus;
  /** succeeded 必须携带；failed 可选；其他终态必须 null */
  readonly result: SubagentResultV1 | null;
  readonly reasonCode: string | null;
  readonly usage: SubagentRunUsage | null;
  /** 终态 result/status 协议消息 Envelope（sequence 由 Store 分配） */
  readonly resultEnvelope: Omit<AgentMessageEnvelopeV1, "sequence">;
  readonly mailbox: {
    readonly mailboxId: ParentMailboxId;
    readonly messageId: AgentMessageId;
    readonly notificationKind: ParentMailboxNotificationKind;
    readonly operationId: string;
    readonly triggerParentTurn: boolean;
  };
  readonly now: string;
}

export interface CompleteRunWithResultResult {
  readonly run: SubagentRunRecord;
  readonly message: SubagentMessageRecord | null;
  readonly mailbox: ParentMailboxRecord | null;
  /** true = 幂等重放：Run 已是同一终态，未写任何新行（§7.2 terminal 重复写幂等） */
  readonly idempotent: boolean;
}

export interface CloseThreadInput {
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly at: string;
  readonly closeReason: string | null;
  /** 同一事务内抑制的 Mailbox 项（§16.4 #6） */
  readonly suppressMailboxIds?: readonly ParentMailboxId[];
}

export interface CloseThreadResult {
  readonly thread: SubagentThreadRecord;
  /** true = 本次调用直接进入 closed；false = 有活动 Run，仅进入 closing（待取消后 markClosed） */
  readonly closedNow: boolean;
  readonly suppressed: number;
}

export interface WaitingForInputWithMailboxInput {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  /** input_required 协议消息 Envelope（sequence 由 Store 分配） */
  readonly envelope: Omit<AgentMessageEnvelopeV1, "sequence">;
  readonly mailbox: {
    readonly mailboxId: ParentMailboxId;
    readonly messageId: AgentMessageId;
    readonly operationId: string;
  };
  readonly now: string;
}

export interface WaitingForInputWithMailboxResult {
  readonly run: SubagentRunRecord;
  readonly message: SubagentMessageRecord;
  readonly mailbox: ParentMailboxRecord;
}

export interface MarkRunStartedWithMailboxInput {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly mailbox: {
    readonly mailboxId: ParentMailboxId;
    readonly messageId: AgentMessageId;
    readonly operationId: string;
  };
  readonly now: string;
}

export interface MarkRunStartedWithMailboxResult {
  readonly run: SubagentRunRecord;
  readonly mailbox: ParentMailboxRecord;
}

export class SubagentTransactions {
  constructor(
    private readonly database: Database.Database,
    private readonly deps: {
      readonly threadStore: ThreadStore;
      readonly runStore: RunStore;
      readonly messageStore: MessageStore;
      readonly mailboxStore: ParentMailboxStore;
    },
  ) {}

  /** §16.4 #1：创建 Thread + first Run + 首条 task message 单事务（先 Thread → Run → 消息） */
  createThreadWithFirstRun(input: CreateThreadWithFirstRunInput): CreateThreadWithFirstRunResult {
    return this.database
      .transaction(() => {
        const thread = this.deps.threadStore.create({
          threadId: input.thread.threadId,
          ownerAgentId: input.ownership.ownerAgentId,
          parentSessionId: input.ownership.parentSessionId,
          createdFromTurnId: input.thread.createdFromTurnId,
          title: input.thread.title,
          modelProviderId: input.thread.modelProviderId,
          modelId: input.thread.modelId,
          modelSource: input.thread.modelSource,
          thinkingLevel: input.thread.thinkingLevel,
          workspaceCwd: input.thread.workspaceCwd,
          capabilityCeiling: input.thread.capabilityCeiling,
          contextPacketHash: input.thread.contextPacketHash,
          createdAt: input.now,
        });
        const run = this.deps.runStore.create(
          {
            runId: input.firstRun.runId,
            threadId: input.thread.threadId,
            triggerMessageId: input.firstRun.triggerMessageId,
            limits: input.limits ?? SUBAGENT_RUN_LIMITS_DEFAULTS,
            createdAt: input.now,
          },
          input.ownership,
        );
        const message = this.deps.messageStore.append({
          envelope: input.taskEnvelope,
          ownership: input.ownership,
          createdAt: input.now,
        });
        return { thread, run, message: message.message };
      })
      .immediate();
  }

  /**
   * §16.4 #4：terminal Run + result + result message + parent mailbox 单事务。
   * - Run 已终态且 == to：幂等返回，不写任何新行；
   * - 事务内任何一步失败（状态机冲突 / Envelope 校验失败 / mailbox
   *   UNIQUE 冲突）整体回滚，Run 保持原状态。
   */
  completeRunWithResult(input: CompleteRunWithResultInput): CompleteRunWithResultResult {
    return this.database
      .transaction(() => {
        const { run, idempotent } = this.deps.runStore.completeRun(
          {
            runId: input.runId,
            from: input.from,
            to: input.to,
            result: input.result,
            reasonCode: input.reasonCode,
            usage: input.usage,
            now: input.now,
          },
          input.ownership,
        );
        if (idempotent) {
          return { run, message: null, mailbox: null, idempotent: true };
        }
        const message = this.deps.messageStore.append({
          envelope: input.resultEnvelope,
          ownership: input.ownership,
          createdAt: input.now,
        });
        const mailbox = this.deps.mailboxStore.insert({
          mailboxId: input.mailbox.mailboxId,
          ownerAgentId: input.ownership.ownerAgentId,
          parentSessionId: input.ownership.parentSessionId,
          threadId: input.threadId,
          runId: input.runId,
          messageId: input.mailbox.messageId,
          notificationKind: input.mailbox.notificationKind,
          triggerParentTurn: input.mailbox.triggerParentTurn,
          operationId: input.mailbox.operationId,
          createdAt: input.now,
        });
        return { run, message: message.message, mailbox, idempotent: false };
      })
      .immediate();
  }

  /**
   * §16.4 #6：close Thread + mailbox suppression 单事务。
   * - 无活动 Run：open → closing → closed（closedNow=true）；
   * - 有活动 Run：open → closing（closedNow=false，协调器取消后 markClosed）；
   * - 已 closed：幂等返回；
   * - suppressMailboxIds 在同一事务内标记 suppressed（§14.2 父级归档/删除联动）。
   */
  closeThread(input: CloseThreadInput): CloseThreadResult {
    return this.database
      .transaction(() => {
        const current = this.deps.threadStore.get(input.threadId, input.ownership);
        if (current === null) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${input.threadId} not found`);
        }
        if (current.status === "closed") {
          return { thread: current, closedNow: false, suppressed: 0 };
        }
        if (current.status === "closing" && this.deps.runStore.hasActiveRun(input.threadId, input.ownership)) {
          throw new SubagentStoreError(
            "subagent_run_state_conflict",
            `thread ${input.threadId} is closing with an active run; cancel the run first`,
          );
        }
        const hasActive = current.status === "open" && this.deps.runStore.hasActiveRun(input.threadId, input.ownership);
        let thread: SubagentThreadRecord;
        let closedNow: boolean;
        if (hasActive) {
          thread = this.deps.threadStore.beginClosing(input.threadId, input.ownership, input.at);
          closedNow = false;
        } else {
          if (current.status === "open") {
            this.deps.threadStore.beginClosing(input.threadId, input.ownership, input.at);
          }
          thread = this.deps.threadStore.markClosed(input.threadId, input.ownership, input.at, input.closeReason);
          closedNow = true;
        }
        let suppressed = 0;
        if (input.suppressMailboxIds !== undefined) {
          for (const mailboxId of input.suppressMailboxIds) {
            if (this.deps.mailboxStore.markSuppressed(mailboxId, input.ownership, input.at)) {
              suppressed += 1;
            }
          }
        }
        return { thread, closedNow, suppressed };
      })
      .immediate();
  }

  /**
   * §13.3：request_parent_input 原子写消息 + waiting_for_input + Parent Mailbox
   * （§8.4：input_required 可唤醒父 Turn）。中途任何一步失败整体回滚，
   * Run 保持 running，不产生半写状态（§22.3）。
   */
  waitingForInputWithMailbox(input: WaitingForInputWithMailboxInput): WaitingForInputWithMailboxResult {
    return this.database
      .transaction(() => {
        const { run } = this.deps.runStore.transit(
          { runId: input.runId, from: "running", to: "waiting_for_input", reasonCode: null, now: input.now },
          input.ownership,
        );
        const { message } = this.deps.messageStore.append({
          envelope: input.envelope,
          ownership: input.ownership,
          createdAt: input.now,
        });
        const mailbox = this.deps.mailboxStore.insert({
          mailboxId: input.mailbox.mailboxId,
          ownerAgentId: input.ownership.ownerAgentId,
          parentSessionId: input.ownership.parentSessionId,
          threadId: input.threadId,
          runId: input.runId,
          messageId: input.mailbox.messageId,
          notificationKind: "input_required",
          triggerParentTurn: true,
          operationId: input.mailbox.operationId,
          createdAt: input.now,
        });
        return { run, message, mailbox };
      })
      .immediate();
  }

  /**
   * §14.1：Run started 写入不唤醒父 Turn 的状态 Mailbox（§8.4：started 只供
   * 状态查询）。与 starting → running 转换同事务；enqueue 幂等
   * （operationId=subagent-started-<runId>，重放不重复副作用）。
   */
  markRunStartedWithMailbox(input: MarkRunStartedWithMailboxInput): MarkRunStartedWithMailboxResult {
    return this.database
      .transaction(() => {
        const { run } = this.deps.runStore.transit(
          { runId: input.runId, from: "starting", to: "running", reasonCode: null, now: input.now },
          input.ownership,
        );
        const mailbox = this.deps.mailboxStore.enqueue({
          mailboxId: input.mailbox.mailboxId,
          ownerAgentId: input.ownership.ownerAgentId,
          parentSessionId: input.ownership.parentSessionId,
          threadId: input.threadId,
          runId: input.runId,
          messageId: input.mailbox.messageId,
          notificationKind: "started",
          triggerParentTurn: false,
          operationId: input.mailbox.operationId,
          createdAt: input.now,
        });
        return { run, mailbox };
      })
      .immediate();
  }
}
