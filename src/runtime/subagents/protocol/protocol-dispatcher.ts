import Value from "typebox/value";

import {
  SUBAGENT_MESSAGE_ID_PREFIX,
  SUBAGENT_MAILBOX_ID_PREFIX,
  SubagentSteerV1Schema,
  isSubagentRunTerminal,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type AgentMessagePartV1,
  type ParentMailboxId,
  type SubagentDeliveryMode,
  type SubagentErrorCode,
  type SubagentRunId,
  type SubagentSteerAction,
  type SubagentSteerV1,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import type { SubagentMessageRecord } from "../stores/message-store.js";import { MessageStore } from "../stores/message-store.js";
import type { SubagentRunRecord } from "../stores/run-store.js";
import { RunStore } from "../stores/run-store.js";
import type { SubagentTransactions } from "../stores/subagent-transactions.js";
import type { SubagentOwnership } from "../stores/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：协议 Dispatcher（plans/phase-14.md §8.2 / §13.4 / §16.4 #5）
//
// AgentMessageEnvelopeV1 store-first dispatch：
// - 消息先写 subagent_messages（Store 层，§8.2），提交后才交给 Runtime；
// - 本 Dispatcher 只处理父 → 子方向（recipient=subagent）：task/steer/cancel；
//   delivery_status 流转 queued → delivering → delivered/failed（幂等）；
// - task：Run 存在即视为由 Run 消费（T4 Host 启动时渲染 trigger 消息）；
// - steer：queue → followUp；interrupt → steer；answer_input → resumeFromInput
//   （§13.4）；active Run 由 Host 应用，queued/starting 延迟到激活后按
//   sequence 应用（deferred + 短退避重试）；P0-1：Host 返回 deferred（Session
//   未就绪）同样走退避重试——消息保持 delivering，绝不静默丢弃/误标 delivered；
// - cancel：active Run 交给 Host.cancelRun（→ cancelled 终态事务）；queued
//   Run 直接终态化（§16.4 #5 取消终态 + terminal message + mailbox），并从
//   Scheduler 排队队列移除；终态 Run 的消息迟到结算为 delivered（无副作用）；
// - 子 → 父方向消息（progress/input_required/result/status）的父侧消费经
//   Parent Mailbox 跟踪（mailbox 行与消息共享 messageId），此处记账 delivered；
// - 投递失败不删除记录（§8.2），markDeliveryFailed 后由 retryPending/
//   启动恢复重试；重放（already-delivered）不重复副作用（§25.2 messageId
//   重放不重复执行）。
// ═══════════════════════════════════════════════════════════════

/** Runtime 侧投递端口（T6 接线到 SubagentRuntimeHost；测试注入 Faux） */
export interface SubagentRuntimeDispatchPort {
  deliverParentMessage(
    input: {
      readonly runId: SubagentRunId;
      readonly messageType: "steer" | "cancel";
      readonly deliveryMode: SubagentDeliveryMode;
      readonly instruction: string | null;
    },
    ownership: SubagentOwnership,
  ): "applied" | "deferred" | "not-active";
  resumeFromInput(runId: SubagentRunId, answerText: string, ownership: SubagentOwnership): boolean;
}

/** 生产接线：把 SubagentRuntimeHost 适配为投递端口 */
export class RuntimeHostDispatchPort implements SubagentRuntimeDispatchPort {
  constructor(private readonly host: { deliverParentMessage(input: {
    readonly runId: SubagentRunId;
    readonly messageType: "steer" | "cancel";
    readonly deliveryMode: SubagentDeliveryMode;
    readonly instruction: string | null;
  }, ownership: SubagentOwnership): "applied" | "deferred" | "not-active"; resumeFromInput(runId: SubagentRunId, answerText: string, ownership: SubagentOwnership, at: string): boolean }) {}

  deliverParentMessage(
    input: {
      readonly runId: SubagentRunId;
      readonly messageType: "steer" | "cancel";
      readonly deliveryMode: SubagentDeliveryMode;
      readonly instruction: string | null;
    },
    ownership: SubagentOwnership,
  ): "applied" | "deferred" | "not-active" {
    return this.host.deliverParentMessage(input, ownership);
  }

  resumeFromInput(runId: SubagentRunId, answerText: string, ownership: SubagentOwnership): boolean {
    return this.host.resumeFromInput(runId, answerText, ownership, new Date().toISOString());
  }
}

export interface ProtocolDispatcherDeps {
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly transactions: SubagentTransactions;
  /** Runtime 投递端口（生产：RuntimeHostDispatchPort(SubagentRuntimeHost)） */
  readonly runtime: SubagentRuntimeDispatchPort;
  /** Scheduler（可选）：queued Run 被取消后移除排队项 */
  readonly scheduler?: { remove(runId: SubagentRunId): boolean };
  readonly now?: () => number;
  /** deferred 投递退避：base 默认 1s，上限默认 30s（启动恢复兜底） */
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  /** 诊断回调（T7 observability 埋点；best-effort） */
  readonly onDiagnostic?: (event: { readonly messageId: AgentMessageId; readonly code: string; readonly detail: string }) => void;
}

export type DispatchResult =
  | { readonly status: "delivered" }
  | { readonly status: "deferred" }
  | { readonly status: "already-delivered" }
  | { readonly status: "failed"; readonly code: SubagentErrorCode };

/** steer data part 的解析结果（§8.3：data part 必须过 TypeBox 校验） */
export interface ParsedSteerInstruction {
  readonly action: SubagentSteerAction;
  readonly instruction: string;
  readonly reason: string;
}

export class ProtocolDispatcher {
  private readonly now: () => number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly deferredTimers = new Map<AgentMessageId, NodeJS.Timeout>();
  private readonly attempts = new Map<AgentMessageId, number>();

  constructor(private readonly deps: ProtocolDispatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = deps.retryMaxDelayMs ?? 30_000;
  }

  /**
   * store-first dispatch（§8.2）：消息已由 MessageStore.append 持久化，
   * 这里负责 delivery 状态流转与 Runtime 应用。幂等：delivered 重放返回
   * already-delivered，不重复副作用。
   */
  dispatch(messageId: AgentMessageId, ownership: SubagentOwnership): DispatchResult {
    const message = this.deps.messages.get(messageId, ownership);
    if (message === null) {
      return { status: "failed", code: "subagent_not_found" };
    }
    if (message.deliveryStatus === "delivered") {
      return { status: "already-delivered" };
    }
    // store-first（§8.2）：queued → delivering（幂等）后才尝试投递
    this.deps.messages.markDelivering(messageId, ownership);
    // task 消息：Run 存在即视为由 Run 执行消费（T4 Host 在启动时渲染 trigger）
    if (message.messageType === "task") {
      this.markDelivered(messageId, ownership);
      return { status: "delivered" };
    }
    const run = this.deps.runs.get(message.runId, ownership);
    if (run === null) {
      this.deps.messages.markDeliveryFailed(messageId, ownership);
      return { status: "failed", code: "subagent_not_found" };
    }
    if (isSubagentRunTerminal(run.status)) {
      // 迟到消息：终态后无副作用可应用（§13.4：取消优先级高于未投递 steer）
      this.markDelivered(messageId, ownership);
      return { status: "delivered" };
    }
    if (message.messageType === "cancel") {
      return this.dispatchCancel(message, run, ownership);
    }
    if (message.messageType === "steer") {
      return this.dispatchSteer(message, run, ownership);
    }
    // 子 → 父方向（progress/input_required/result/error/status）：父侧消费经
    // Mailbox 跟踪（mailbox 行与消息共享 messageId，由 Coordinator 结算）；
    // 此处记账 delivered 防重放。
    this.markDelivered(messageId, ownership);
    return { status: "delivered" };
  }

  /**
   * 启动恢复/重试：扫描本 Server 未结算的父 → 子方向消息重新 dispatch
   * （§8.2：投递失败不删除记录，可重试；§16.5 启动恢复）。
   */
  retryPending(): { readonly retried: number } {
    let retried = 0;
    for (const { message, ownership } of this.deps.messages.listUndeliveredToSubagentWithOwnership(500)) {
      const outcome = this.dispatch(message.messageId, ownership);
      if (outcome.status === "delivered" || outcome.status === "already-delivered") {
        retried += 1;
      }
    }
    return { retried };
  }

  /** 清退避定时器（Server 关闭/重启；DB delivering 行由恢复重试接管） */
  dispose(): void {
    for (const timer of this.deferredTimers.values()) {
      clearTimeout(timer);
    }
    this.deferredTimers.clear();
    this.attempts.clear();
  }

  // ── cancel ───────────────────────────────────────────────────

  private dispatchCancel(message: SubagentMessageRecord, run: SubagentRunRecord, ownership: SubagentOwnership): DispatchResult {
    const { messageId, runId } = message;
    if (run.status === "queued") {
      // queued Run 直接终态化（§16.4 #5：取消终态 + terminal message + mailbox）
      const now = this.iso();
      try {
        const terminalMessageId = this.newMessageId();
        this.deps.transactions.completeRunWithResult(
          {
            runId,
            threadId: message.threadId,
            ownership,
            from: "queued",
            to: "cancelled",
            result: null,
            reasonCode: "subagent_cancelled_by_parent",
            usage: null,
            resultEnvelope: this.statusEnvelope(message.threadId, runId, terminalMessageId, "cancelled", "subagent_cancelled_by_parent", ownership.ownerAgentId, now),
            mailbox: {
              mailboxId: this.newMailboxId(),
              messageId: terminalMessageId,
              notificationKind: "cancelled",
              operationId: `subagent-cancel-queued-${runId}`,
              triggerParentTurn: false,
            },
            now,
          },
        );
        this.deps.scheduler?.remove(runId);
      } catch (error) {
        this.deps.messages.markDeliveryFailed(messageId, ownership);
        this.diagnose(messageId, "subagent_operation_failed", `queued cancel 终态事务失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
        return { status: "failed", code: "subagent_operation_failed" };
      }
      this.markDelivered(messageId, ownership);
      return { status: "delivered" };
    }
    // starting（未 active）/running/waiting_for_input：交给 Host.cancelRun
    const outcome = this.deps.runtime.deliverParentMessage(
      { runId, messageType: "cancel", deliveryMode: message.deliveryMode, instruction: null },
      ownership,
    );
    if (outcome === "applied") {
      this.markDelivered(messageId, ownership);
      return { status: "delivered" };
    }
    return this.defer(message, ownership); // not-active（starting 窗口）：延迟重试
  }

  // ── steer ────────────────────────────────────────────────────

  private dispatchSteer(message: SubagentMessageRecord, run: SubagentRunRecord, ownership: SubagentOwnership): DispatchResult {
    const { messageId, runId } = message;
    const parsed = extractSteerInstruction(message.envelope.parts);
    if (parsed === null) {
      // data part schema 匹配但校验失败 / 无文本 → 非法消息不入 Runtime（§8.3）
      this.deps.messages.markDeliveryFailed(messageId, ownership);
      this.diagnose(messageId, "subagent_operation_failed", "steer 消息缺少合法 SubagentSteerV1 data part 或 text part");
      return { status: "failed", code: "subagent_operation_failed" };
    }
    if (run.status === "queued" || run.status === "starting") {
      // 延迟到 Run 激活后按 sequence 应用（§13.4：同一 Run 的 Steer 按消息
      // sequence 应用；queued/starting 无活动 Session）
      return this.defer(message, ownership);
    }
    if (parsed.action === "answer_input" && run.status === "waiting_for_input") {
      const ok = this.deps.runtime.resumeFromInput(runId, parsed.instruction, ownership);
      if (ok) {
        this.markDelivered(messageId, ownership);
        return { status: "delivered" };
      }
      return this.defer(message, ownership);
    }
    const outcome = this.deps.runtime.deliverParentMessage(
      { runId, messageType: "steer", deliveryMode: message.deliveryMode, instruction: parsed.instruction },
      ownership,
    );
    if (outcome === "applied") {
      this.markDelivered(messageId, ownership);
      return { status: "delivered" };
    }
    return this.defer(message, ownership);
  }

  // ── deferred 重试（§8.2：投递失败不删除记录，可重试）──────────

  private defer(message: SubagentMessageRecord, ownership: SubagentOwnership): DispatchResult {
    // 保持 delivering；短退避重试（Run 激活/终态后结算；上限 30s，
    // 超出后由启动恢复/retryPending 兜底）
    const attempt = (this.attempts.get(message.messageId) ?? 0) + 1;
    this.attempts.set(message.messageId, attempt);
    const delay = Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), this.retryMaxDelayMs);
    const existing = this.deferredTimers.get(message.messageId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.deferredTimers.delete(message.messageId);
      try {
        this.dispatch(message.messageId, ownership); // 重新读取：状态可能已变化
      } catch {
        // 数据异常由诊断回调上报，不活锁
      }
    }, delay);
    this.deferredTimers.set(message.messageId, timer);
    return { status: "deferred" };
  }

  private markDelivered(messageId: AgentMessageId, ownership: SubagentOwnership): void {
    this.deps.messages.markDelivered(messageId, ownership, this.iso());
  }

  private diagnose(messageId: AgentMessageId, code: string, detail: string): void {
    this.deps.onDiagnostic?.({ messageId, code, detail });
  }

  private statusEnvelope(
    threadId: SubagentThreadId,
    runId: SubagentRunId,
    messageId: AgentMessageId,
    statusText: string,
    reasonCode: string | null,
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
      parts: [{ kind: "text", text: reasonCode === null ? statusText : `${statusText}（${reasonCode}）` }],
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

/**
 * 从 Envelope parts 提取 steer 指令（§8.3：data part 必须按 schema 过
 * TypeBox 校验，未知 schema 不进入 Runtime）：
 * - subagent.steer.v1 data part → SubagentSteerV1（校验失败 → null）；
 * - 无 data part 时退回 text part（文本纠偏按 queue 语义投递）。
 */
export function extractSteerInstruction(parts: readonly AgentMessagePartV1[]): ParsedSteerInstruction | null {
  for (const part of parts) {
    if (part.kind === "data") {
      if (part.schema === "subagent.steer.v1") {
        if (Value.Check(SubagentSteerV1Schema, part.value)) {
          const steer = part.value as SubagentSteerV1;
          return { action: steer.action, instruction: steer.instruction, reason: steer.reason };
        }
        return null; // schema 匹配但内容非法 → 拒绝投递
      }
      continue; // 其他 schema（result/input）不参与 steer 解析
    }
  }
  const text = parts
    .filter((part): part is { readonly kind: "text"; readonly text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text.length === 0) {
    return null;
  }
  return { action: "redirect", instruction: text, reason: "" };
}

function cryptoRandomSuffix(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string };
  const uuid = crypto.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return uuid.replaceAll("-", "").slice(0, 16);
}
