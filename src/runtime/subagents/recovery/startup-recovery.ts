import {
  SUBAGENT_MESSAGE_ID_PREFIX,
  SUBAGENT_MAILBOX_ID_PREFIX,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type ParentMailboxId,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import type { ParentMailboxDeliveryCoordinator } from "../mailbox/parent-mailbox-delivery-coordinator.js";
import { MessageStore } from "../stores/message-store.js";
import { RunStore } from "../stores/run-store.js";
import type { SubagentTransactions } from "../stores/subagent-transactions.js";
import { ThreadStore } from "../stores/thread-store.js";
import { WorkspaceLeaseStore } from "../stores/workspace-lease-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：startup orphan recovery（plans/phase-14.md §16.5 / §25.6）
//
// Server 启动时执行（migration v12 之后；T6 组合根在恢复完成后才标记
// Subagent Runtime available，恢复失败 → subagent_runtime_unavailable）：
// 1. 原子把所有非终态 Run（queued/starting/running/waiting_for_input/
//    cancelling）标记 interrupted，并为每个 Run 写 terminal message +
//    parent mailbox（§16.5；interrupted 通知可唤醒父 Turn，§8.4）；
//    queued Run 也终态化（§25.6：Server crash 后 queued 同样 interrupted，
//    平台不自动 resume；主 Agent 检查后可在原 Thread 新建 Run，§7.2）；
// 2. closing Thread 且无活动 Run → 终态化 closed（崩溃遗留的 closing 不
//    卡死，§7.1 关闭规则）；
// 3. 释放过期 workspace Lease（§16.5 / §16.2：只存当前有效写 Lease）；
// 4. 扫描 pending/delivering mailbox 并重试（§14.3：delivering 视为可重试；
//    由 ParentMailboxDeliveryCoordinator.retryPending 结算）。
//
// 恢复失败属于基础设施错误（§16.5）：逐项聚合 errors；调用方（组合根）
// 依据 report.errors 决定 Subagent 系统可用性，不能 fail-open 创建无人执行
// 的 Run。
// ═══════════════════════════════════════════════════════════════

export interface SubagentStartupRecoveryDeps {
  readonly runs: RunStore;
  readonly threads: ThreadStore;
  readonly messages: MessageStore;
  readonly transactions: SubagentTransactions;
  readonly workspaceLeases: WorkspaceLeaseStore;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly now?: () => number;
}

export interface SubagentStartupRecoveryReport {
  readonly interruptedRuns: number;
  readonly finalizedClosingThreads: number;
  readonly releasedWorkspaceLeases: number;
  readonly mailboxRetried: boolean;
  readonly errors: readonly string[];
}

export class SubagentStartupRecovery {
  private readonly now: () => number;

  constructor(private readonly deps: SubagentStartupRecoveryDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  run(): SubagentStartupRecoveryReport {
    const errors: string[] = [];
    let interruptedRuns = 0;
    let finalizedClosingThreads = 0;

    // 1. 全部非终态 Run → interrupted + terminal message + mailbox（§16.5 / §16.4 #7）
    //    （最小引用扫描：corrupted 行逐项聚合诊断，不阻断整体恢复）
    for (const { runId, threadId, status, ownership } of this.deps.runs.listActiveRunRefsWithOwnership()) {
      const now = this.iso();
      try {
        const terminalMessageId = this.newMessageId();
        this.deps.transactions.completeRunWithResult(
          {
            runId,
            threadId,
            ownership,
            from: status,
            to: "interrupted",
            result: null,
            reasonCode: "subagent_recovery_interrupted",
            usage: null,
            resultEnvelope: this.statusEnvelope(threadId, runId, terminalMessageId, ownership.ownerAgentId, now),
            mailbox: {
              mailboxId: this.newMailboxId(),
              messageId: terminalMessageId,
              notificationKind: "interrupted",
              operationId: `subagent-recovery-${runId}`,
              triggerParentTurn: true,
            },
            now,
          },
        );
        interruptedRuns += 1;
      } catch (error) {
        errors.push(`interrupt ${runId}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      }
    }

    // 2. closing Thread 且无活动 Run → closed（崩溃遗留的 closing 终态化）
    for (const { thread, ownership } of this.deps.threads.listClosingWithOwnership()) {
      try {
        if (!this.deps.runs.hasActiveRun(thread.threadId, ownership)) {
          this.deps.transactions.closeThread({
            threadId: thread.threadId,
            ownership,
            at: this.iso(),
            closeReason: "subagent_recovery_finalize_closing",
            suppressMailboxIds: [],
          });
          finalizedClosingThreads += 1;
        }
      } catch (error) {
        errors.push(`finalize ${thread.threadId}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      }
    }

    // 3. 释放过期 workspace Lease（§16.5）
    let releasedWorkspaceLeases = 0;
    try {
      releasedWorkspaceLeases = this.deps.workspaceLeases.deleteExpired(this.iso());
    } catch (error) {
      errors.push(`workspace lease cleanup: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }

    // 4. 扫描 pending/delivering mailbox 并重试（§14.3 / §16.5）
    let mailboxRetried = false;
    try {
      this.deps.coordinator.retryPending();
      mailboxRetried = true;
    } catch (error) {
      errors.push(`mailbox retry: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }

    return { interruptedRuns, finalizedClosingThreads, releasedWorkspaceLeases, mailboxRetried, errors };
  }

  private statusEnvelope(
    threadId: SubagentThreadId,
    runId: SubagentRunId,
    messageId: AgentMessageId,
    ownerAgentId: string,
    now: string,
  ): Omit<AgentMessageEnvelopeV1, "sequence"> {
    return {
      protocol: "opencolorful.agent-message",
      version: 1,
      messageId,
      contextId: threadId,
      taskId: runId,
      sender: { kind: "system", id: "subagent-system" },
      recipient: { kind: "parent_agent", id: ownerAgentId },
      messageType: "status",
      deliveryMode: "mailbox",
      parts: [{ kind: "text", text: "interrupted（subagent_recovery_interrupted）" }],
      metadata: { createdAt: now, traceId: `trace-${runId}`, schemaName: "subagent.status" },
    };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private newMessageId(): AgentMessageId {
    return `${SUBAGENT_MESSAGE_ID_PREFIX}${cryptoRandomSuffix()}` as AgentMessageId;
  }

  private newMailboxId(): ParentMailboxId {
    return `${SUBAGENT_MAILBOX_ID_PREFIX}${cryptoRandomSuffix()}` as ParentMailboxId;
  }
}

function cryptoRandomSuffix(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string };
  const uuid = crypto.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return uuid.replaceAll("-", "").slice(0, 16);
}
