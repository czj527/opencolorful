import Value from "typebox/value";

import {
  SubagentContextPacketV1Schema,
  SubagentTaskBriefV1Schema,
  type AgentMessagePartV1,
  type AgentMessageId,
  type SubagentArtifactRef,
  type SubagentContextRefV1,
  type SubagentContextPacketV1,
  type SubagentDeliveryMode,
  type SubagentMessageType,
  type SubagentRecipientKind,
  type SubagentRunId,
  type SubagentSenderKind,
  type SubagentTaskBriefV1,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { ArtifactStore, type SubagentArtifactRecord } from "../stores/artifact-store.js";
import { MessageStore, type SubagentMessageRecord } from "../stores/message-store.js";
import { RunStore, type SubagentRunRecord } from "../stores/run-store.js";
import { ThreadStore, type SubagentThreadRecord } from "../stores/thread-store.js";
import type { SubagentMessageDeliveryStatus, SubagentOwnership } from "../stores/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Thread Transcript 投影（plans/phase-14.md §17.1 / §11.3）
//
// 只读投影（SQLite 为权威，transcript 不替代）：从 subagent_threads /
// subagent_runs / subagent_messages / subagent_artifacts 投影 Web 面板
// （T8）与 /logs 可消费的完整 Thread 会话视图。
//
// - 可见项（§17.1）：Thread 元信息、Run 列表（状态/预算/结果）、全部协议
//   消息（TaskBrief/ContextPacket 快照提取、Steer、progress、input_required、
//   result、cancel、status）、Artifact 引用。不投影模型隐藏推理；
// - 消息正文按 AgentMessagePartV1 逐 part 投影（text 原样、data 保留
//   schema+value、context_ref/artifact_ref 保留引用），大输出由调用方按
//   afterSequence/limit 分页读取，不在此截断；
// - TaskBrief/ContextPacket 快照：从 task 消息 data parts 中提取
//   （schema=subagent.task_brief.v1 / subagent.context_packet.v1，T6 写入约定），
//   过 TypeBox 校验后才输出；缺失时返回 null（简报可能只存在于 Prompt）；
// - Thread 关闭后 transcript 只读（§11.3）：本模块不提供任何写接口；
// - 所有查询携带 SubagentOwnership（§22.1），归属不匹配由 Store 层抛
//   subagent_ownership_denied。
// ═══════════════════════════════════════════════════════════════

/** 消息 part 的投影视图（与 AgentMessagePartV1 一一对应，字段扁平化） */
export type SubagentTranscriptPartView =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "data"; readonly schema: string; readonly value: unknown }
  | { readonly kind: "context_ref"; readonly ref: SubagentContextRefV1 }
  | { readonly kind: "artifact_ref"; readonly ref: SubagentArtifactRef };

/** 单条协议消息的 transcript 投影（envelope 的可见子集，不含权限字段） */
export interface SubagentTranscriptMessage {
  readonly messageId: AgentMessageId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly sequence: number;
  readonly messageType: SubagentMessageType;
  readonly sender: { readonly kind: SubagentSenderKind; readonly id: string };
  readonly recipient: { readonly kind: SubagentRecipientKind; readonly id: string };
  readonly deliveryMode: SubagentDeliveryMode;
  readonly deliveryStatus: SubagentMessageDeliveryStatus;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  readonly traceId: string;
  readonly correlationId?: string;
  readonly causationId?: AgentMessageId;
  readonly parts: readonly SubagentTranscriptPartView[];
}

/** Thread transcript 快照（初始页；消息按 sequence 升序，超限由 truncated 标记） */
export interface SubagentThreadTranscript {
  readonly thread: SubagentThreadRecord;
  readonly runs: readonly SubagentRunRecord[];
  readonly messages: readonly SubagentTranscriptMessage[];
  readonly artifacts: readonly SubagentArtifactRecord[];
  /** 快照内 TaskBrief（从 task 消息 data parts 提取，可能为 null） */
  readonly taskBrief: SubagentTaskBriefV1 | null;
  /** 快照内 ContextPacket（同上，可能为 null） */
  readonly contextPacket: SubagentContextPacketV1 | null;
  /** 下一条消息 sequence（客户端分页游标） */
  readonly nextMessageSequence: number;
  /** true = 消息页被 limit 截断，需按 nextMessageSequence 继续拉取 */
  readonly truncated: boolean;
}

export interface TranscriptPageOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

/** 单页消息结果（分页游标与 SSE event cursor 分离，§17.4） */
export interface SubagentMessagePage {
  readonly items: readonly SubagentTranscriptMessage[];
  readonly nextSequence: number;
  readonly truncated: boolean;
}

export const SUBAGENT_TRANSCRIPT_PAGE_MAX = 200;

/** TaskBrief/ContextPacket 的 data part schema 约定（T6 写入；缺失时快照为 null） */
export const SUBAGENT_TASK_BRIEF_SCHEMA = "subagent.task_brief.v1" as const;
export const SUBAGENT_CONTEXT_PACKET_SCHEMA = "subagent.context_packet.v1" as const;

export class SubagentTranscriptView {
  constructor(
    private readonly deps: {
      readonly threads: ThreadStore;
      readonly runs: RunStore;
      readonly messages: MessageStore;
      readonly artifacts: ArtifactStore;
    },
  ) {}

  /** 完整 Thread 会话快照（thread + runs + 消息首页 + artifacts + 简报快照） */
  getTranscript(
    threadId: SubagentThreadId,
    ownership: SubagentOwnership,
    options: TranscriptPageOptions = {},
  ): SubagentThreadTranscript {
    const thread = this.deps.threads.get(threadId, ownership);
    if (thread === null) {
      throw new SubagentNotFound(threadId);
    }
    const runs = this.deps.runs.listByThread(threadId, ownership);
    const page = this.listMessages(threadId, ownership, options);
    const artifacts = this.deps.artifacts.listByThread(threadId, ownership);
    const { taskBrief, contextPacket } = extractSnapshots(page.items);
    return {
      thread,
      runs,
      messages: page.items,
      artifacts,
      taskBrief,
      contextPacket,
      nextMessageSequence: page.nextSequence,
      truncated: page.truncated,
    };
  }

  /** Thread 内消息按 sequence 升序分页（transcript 分页 cursor，§17.4） */
  listMessages(
    threadId: SubagentThreadId,
    ownership: SubagentOwnership,
    options: TranscriptPageOptions = {},
  ): SubagentMessagePage {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), SUBAGENT_TRANSCRIPT_PAGE_MAX);
    const records = this.deps.messages.listByThread(threadId, ownership, {
      ...(options.afterSequence !== undefined ? { afterSequence: options.afterSequence } : {}),
      limit: limit + 1,
    });
    const truncated = records.length > limit;
    const page = truncated ? records.slice(0, limit) : records;
    // cursor 语义：nextSequence = 本页最后一条已投递 sequence（客户端把它作为
    // 下一页 afterSequence 传入 → sequence > cursor，不重不漏、不跳号）
    const last = page[page.length - 1];
    const nextSequence = last !== undefined ? last.sequence : (options.afterSequence ?? 0);
    return {
      items: page.map(projectMessage),
      nextSequence,
      truncated,
    };
  }

  /** Thread 列表（T8 面板入口；按 updated_at DESC） */
  listThreads(ownership: SubagentOwnership, limit = 50): SubagentThreadRecord[] {
    return this.deps.threads.listByOwner(ownership, limit);
  }
}

/** 消息记录 → transcript 投影（envelope 可见子集；parts 逐项投影） */
export function projectMessage(record: SubagentMessageRecord): SubagentTranscriptMessage {
  const envelope = record.envelope;
  return {
    messageId: record.messageId,
    threadId: record.threadId,
    runId: record.runId,
    sequence: record.sequence,
    messageType: record.messageType,
    sender: envelope.sender,
    recipient: envelope.recipient,
    deliveryMode: record.deliveryMode,
    deliveryStatus: record.deliveryStatus,
    consumedAt: record.consumedAt,
    createdAt: record.createdAt,
    traceId: envelope.metadata.traceId,
    ...(envelope.correlationId !== undefined ? { correlationId: envelope.correlationId } : {}),
    ...(envelope.causationId !== undefined ? { causationId: envelope.causationId } : {}),
    parts: envelope.parts.map(projectPart),
  };
}

/** AgentMessagePartV1 → 扁平化投影（不复制协议内部权限结构） */
export function projectPart(part: AgentMessagePartV1): SubagentTranscriptPartView {
  switch (part.kind) {
    case "text":
      return { kind: "text", text: part.text };
    case "data":
      return { kind: "data", schema: part.schema, value: part.value };
    case "context_ref":
      return { kind: "context_ref", ref: part.ref };
    case "artifact_ref":
      return { kind: "artifact_ref", ref: part.ref };
  }
}

/**
 * 从消息页提取 TaskBrief/ContextPacket 快照（§17.1）。约定：T6 把简报写入
 * task 消息的 data parts（schema=subagent.task_brief.v1 / subagent.context_packet.v1）。
 * data value 必须过 TypeBox 校验（跨进程输入），损坏/未知 schema 一律不输出。
 */
export function extractSnapshots(
  messages: readonly SubagentTranscriptMessage[],
): { readonly taskBrief: SubagentTaskBriefV1 | null; readonly contextPacket: SubagentContextPacketV1 | null } {
  let taskBrief: SubagentTaskBriefV1 | null = null;
  let contextPacket: SubagentContextPacketV1 | null = null;
  for (const message of messages) {
    if (taskBrief !== null && contextPacket !== null) break;
    for (const part of message.parts) {
      if (part.kind !== "data") continue;
      if (taskBrief === null && part.schema === SUBAGENT_TASK_BRIEF_SCHEMA) {
        if (Value.Check(SubagentTaskBriefV1Schema, part.value)) {
          taskBrief = part.value as SubagentTaskBriefV1;
        }
      }
      if (contextPacket === null && part.schema === SUBAGENT_CONTEXT_PACKET_SCHEMA) {
        if (Value.Check(SubagentContextPacketV1Schema, part.value)) {
          contextPacket = part.value as SubagentContextPacketV1;
        }
      }
    }
  }
  return { taskBrief, contextPacket };
}

/** Thread 不存在（Store 层对存在但归属不匹配抛 subagent_ownership_denied） */
export class SubagentNotFound extends Error {
  constructor(threadId: SubagentThreadId) {
    super(`subagent thread ${threadId} not found`);
    this.name = "SubagentNotFound";
  }
}
