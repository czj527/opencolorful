import crypto from "node:crypto";

import type {
  ActivityPayload,
  ActorRef,
  EventScope,
  ExecutorRef,
  ResourceRef,
  TraceContext,
} from "../../../contracts/observability.js";
import type {
  AgentMessageId,
  ParentMailboxNotificationKind,
  SubagentResultV1,
  SubagentRunId,
  SubagentRunStatus,
  SubagentThreadId,
} from "../../../contracts/subagents.js";
import { ActivityRecorder, type ActivityRecordInput } from "../../../observability/activity-recorder.js";
import { newSpanId } from "../../../observability/trace-context.js";
import type { SubagentArtifactRecord } from "../stores/artifact-store.js";
import type { SubagentMessageRecord } from "../stores/message-store.js";
import type { ParentMailboxRecord } from "../stores/parent-mailbox-store.js";
import { RunStore, type SubagentRunRecord } from "../stores/run-store.js";
import type { SubagentThreadRecord } from "../stores/thread-store.js";
import type { SubagentOwnership } from "../stores/types.js";
import { SubagentReplayStore } from "../transcript/replay-store.js";
import type { SubagentToolActivityView } from "../transcript/tool-summary.js";
import type { SubagentRuntimeHostDeps } from "../runtime/runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Subagent Observability 投影（plans/phase-14.md §19.1-§19.4）
//
// 从 RuntimeHost 回调（onRunProgress/onMessage/onTerminal/onLeaseLost）与
// T5/T6 生命周期入口投影到 observability 事件（事件名全部来自 T1 冻结目录
// subagent-events.ts，不新增未入目录的事件）与 `subagent:<threadId>` replay。
//
// 投影规则（§19.2）：
// - subagent.run.progress 同一 Run 限频 ≥30s 一条（progressMinIntervalMs），
//   payload 只记录 phase，不记录正文（正文走协议消息/面板流）；
//   Tool delta 不落 durable Activity（§17.2），只走 replay 面板流；
// - 生命周期事件遵守 started/terminal 唯一规则：run 的 started/terminal 共享
//   operationId=`subagent-run-<runId>`，status 按目录 terminalStatuses 映射
//   （timed_out/budget_exhausted → status=failed + attributes.reasonCode）；
// - payload 只记录 ID/hash/count/reasonCode/phase，不记录 TaskBrief/Prompt/
//   结果正文/transcript（§19.3 / §25.7）；
// - scope（§19.1）：ownerAgentId=父 Agent、sessionId=父 Session、
//   subagentThreadId、subagentRunId、turnId=创建 Turn（T6 传入时）；
// - Trace（§19.4）：每个 Run 一个确定性 span（sha256(runId) 前缀），
//   started/terminal 共享该 spanId（traceTree 按 spanId 合并）；traceId 取
//   task 消息 metadata.traceId（父 Turn trace 传播），缺失时回退 `trace-<runId>`；
// - 所有方法 best-effort：投影失败不阻断 Runtime 执行（T4 回调契约）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentObservabilityProjectorDeps {
  readonly activity: ActivityRecorder;
  /** `subagent:<threadId>` 面板流（可选；缺省只写 Activity） */
  readonly replay?: SubagentReplayStore;
  /** onTerminal 投影 run 事件到 replay 时需要（加载终态 Run 记录） */
  readonly runs?: RunStore;
  /** onTerminal 投影终态 result 协议消息（host 不回调 onMessage；可选） */
  readonly messages?: import("../stores/message-store.js").MessageStore;
  /** 同 Run 限频（§19.2：≥30s 一条；测试可调小） */
  readonly progressMinIntervalMs?: number;
  /**
   * T9b：Activity 写入失败回调（§19.3 auditPending 补账）——投影失败不阻断
   * Runtime，但把完整 ActivityRecordInput 交给调用方持久为 auditPending
   * （composition 接线写入 run.audit_pending_json，启动恢复补账）。
   */
  readonly onProjectionFailure?: (input: {
    readonly record: ActivityRecordInput;
    readonly threadId: SubagentThreadId | null;
    readonly runId: SubagentRunId | null;
    readonly ownership: SubagentOwnership | null;
  }) => void;
  readonly now?: () => Date;
}

const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 30_000;

function summaryCodeOf(eventName: string): string {
  return eventName.replace(/\./g, "_");
}

function runSpanId(runId: SubagentRunId): string {
  return crypto.createHash("sha256").update(`subagent-run:${runId}`).digest("hex").slice(0, 16);
}

/** 终态 Run 状态 → 目录事件名 + ActivityStatus（§19.2 映射表） */
function terminalEventOf(status: SubagentRunStatus): { eventName: string; status: "completed" | "failed" | "cancelled" | "interrupted" } {
  switch (status) {
    case "succeeded":
      return { eventName: "subagent.run.completed", status: "completed" };
    case "failed":
      return { eventName: "subagent.run.failed", status: "failed" };
    case "cancelled":
      return { eventName: "subagent.run.cancelled", status: "cancelled" };
    case "timed_out":
      return { eventName: "subagent.run.timed_out", status: "failed" };
    case "interrupted":
      return { eventName: "subagent.run.interrupted", status: "interrupted" };
    case "budget_exhausted":
      return { eventName: "subagent.run.budget_exhausted", status: "failed" };
    default:
      throw new Error(`not a terminal run status: ${status}`);
  }
}

export class SubagentObservabilityProjector {
  private readonly progressMinIntervalMs: number;
  private readonly now: () => Date;
  private readonly replay: SubagentReplayStore | undefined;
  private readonly lastProgressAt = new Map<SubagentRunId, number>();
  /** threadId → ownership（T6 spawn 路径 projectThreadCreated 登记；回调投影据此补 scope） */
  private readonly ownershipByThread = new Map<SubagentThreadId, SubagentOwnership>();
  /** runId → threadId（host 回调只有 runId；run 生命周期入口登记） */
  private readonly threadByRun = new Map<SubagentRunId, SubagentThreadId>();
  /** runId → traceId（取 task 消息 trace；缺失回退） */
  private readonly traceByRun = new Map<SubagentRunId, string>();

  constructor(private readonly deps: SubagentObservabilityProjectorDeps) {
    this.progressMinIntervalMs = deps.progressMinIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
    this.replay = deps.replay;
  }

  // ── RuntimeHost 回调接线（T7：observability 投影从此处接线）────────

  /** onRunProgress：阶段/错误文本 → run.progress（限频）；不落消息 */
  onRunProgress(event: { readonly runId: SubagentRunId; readonly phase?: string; readonly text: string }): void {
    this.projectRunProgress(event.runId, event.phase, this.threadByRun.get(event.runId) ?? null);
  }

  /** onMessage：协议消息 → message.queued + progress/input_required 事件 + replay */
  onMessage(event: { readonly runId: SubagentRunId; readonly message: SubagentMessageRecord }): void {
    this.projectMessage(event.message);
  }

  /** onTerminal：终态 → 目录终态事件 + replay run */
  onTerminal(event: {
    readonly runId: SubagentRunId;
    readonly threadId: SubagentThreadId;
    readonly status: string;
    readonly reasonCode: string | null;
    readonly result: SubagentResultV1 | null;
  }): void {
    this.projectRunTerminal(event.runId, event.threadId, event.status, event.reasonCode, event.result);
  }

  /** onLeaseLost：Lease 丢失 → subagent.runtime.lease_lost */
  onLeaseLost(event: { readonly runId: SubagentRunId }): void {
    const threadId = this.threadByRun.get(event.runId) ?? null;
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName: "subagent.runtime.lease_lost",
        threadId,
        runId: event.runId,
        ownership,
        payload: { summaryCode: "subagent_runtime_lease_lost" },
      },
      { actor: systemActor("subagent-runtime"), executor: systemExecutor("subagent-runtime") },
    );
  }

  // ── T5/T6 生命周期入口（公开投影；T6 spawn/steer、T5 delivery 调用）────

  registerOwnership(threadId: SubagentThreadId, ownership: SubagentOwnership): void {
    this.ownershipByThread.set(threadId, ownership);
  }

  projectThreadCreated(thread: SubagentThreadRecord, ownership: SubagentOwnership, trace?: TraceContext): void {
    this.registerOwnership(thread.threadId, ownership);
    this.activity(
      {
        eventName: "subagent.thread.created",
        threadId: thread.threadId,
        runId: null,
        ownership,
        ...(trace !== undefined ? { trace } : {}),
        payload: {
          summaryCode: "subagent_thread_created",
          attributes: { modelSource: thread.modelSource },
        },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: serviceExecutor() },
    );
  }

  projectThreadClosing(thread: SubagentThreadRecord, ownership: SubagentOwnership): void {
    this.activity(
      {
        eventName: "subagent.thread.closing",
        threadId: thread.threadId,
        runId: null,
        ownership,
        payload: { summaryCode: "subagent_thread_closing" },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: serviceExecutor() },
    );
    this.replay?.publish(thread.threadId, { kind: "thread", status: "closing", at: this.now().toISOString() });
  }

  projectThreadClosed(thread: SubagentThreadRecord, ownership: SubagentOwnership): void {
    this.activity(
      {
        eventName: "subagent.thread.closed",
        threadId: thread.threadId,
        runId: null,
        ownership,
        status: "completed",
        operationId: `subagent-thread-${thread.threadId}`,
        payload: {
          summaryCode: "subagent_thread_closed",
          ...(thread.closeReason !== null ? { attributes: { closeReason: thread.closeReason.slice(0, 200) } } : {}),
        },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: serviceExecutor() },
    );
    this.replay?.publish(thread.threadId, { kind: "thread", status: "closed", at: this.now().toISOString() });
  }

  projectRunQueued(run: SubagentRunRecord, ownership: SubagentOwnership, trace?: TraceContext): void {
    this.registerOwnership(run.threadId, ownership);
    this.threadByRun.set(run.runId, run.threadId);
    if (trace !== undefined) {
      this.traceByRun.set(run.runId, trace.traceId);
    }
    this.activity(
      {
        eventName: "subagent.run.queued",
        threadId: run.threadId,
        runId: run.runId,
        ownership,
        ...(trace !== undefined ? { trace } : {}),
        payload: { summaryCode: "subagent_run_queued", attributes: { ordinal: run.ordinal } },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: subagentExecutor(run.runId) },
    );
  }

  projectRunStarted(run: SubagentRunRecord, ownership: SubagentOwnership, trace?: TraceContext): void {
    this.registerOwnership(run.threadId, ownership);
    this.threadByRun.set(run.runId, run.threadId);
    if (trace !== undefined) {
      this.traceByRun.set(run.runId, trace.traceId);
    }
    this.activity(
      {
        eventName: "subagent.run.started",
        threadId: run.threadId,
        runId: run.runId,
        ownership,
        ...(trace !== undefined ? { trace } : {}),
        status: "started",
        operationId: `subagent-run-${run.runId}`,
        payload: {
          summaryCode: "subagent_run_started",
          attributes: { ordinal: run.ordinal, snapshotId: run.snapshotId ?? "none" },
        },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: subagentExecutor(run.runId) },
    );
    this.replay?.publish(run.threadId, { kind: "run", run });
  }

  /** run.progress（限频 ≥30s 一条；progress 事件不带 status，§19.2；payload 只记 phase） */
  projectRunProgress(runId: SubagentRunId, phase: string | undefined, threadId: SubagentThreadId | null): void {
    const nowMs = this.now().getTime();
    const last = this.lastProgressAt.get(runId) ?? 0;
    if (nowMs - last < this.progressMinIntervalMs) {
      return;
    }
    this.lastProgressAt.set(runId, nowMs);
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName: "subagent.run.progress",
        threadId,
        runId,
        ownership,
        payload: {
          summaryCode: "subagent_run_progress",
          ...(phase !== undefined ? { attributes: { phase: phase.slice(0, 64) } } : {}),
        },
      },
      { actor: subagentActor(runId), executor: subagentExecutor(runId) },
    );
  }

  projectInputRequired(runId: SubagentRunId, threadId: SubagentThreadId, question: string): void {
    void question; // 只记录事件，问题正文走协议消息/面板流（§19.3）
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName: "subagent.run.input_required",
        threadId,
        runId,
        ownership,
        payload: { summaryCode: "subagent_run_input_required" },
      },
      { actor: subagentActor(runId), executor: subagentExecutor(runId) },
    );
  }

  /** 终态投影（onTerminal 同路径；status 必须为终态） */
  projectRunTerminal(
    runId: SubagentRunId,
    threadId: SubagentThreadId,
    status: string,
    reasonCode: string | null,
    result: SubagentResultV1 | null,
  ): void {
    const runStatus = status as SubagentRunStatus;
    const terminal = terminalEventOf(runStatus);
    const ownership = this.ownershipOf(threadId);
    this.threadByRun.set(runId, threadId);
    this.activity(
      {
        eventName: terminal.eventName,
        threadId,
        runId,
        ownership,
        status: terminal.status,
        operationId: `subagent-run-${runId}`,
        payload: {
          summaryCode: summaryCodeOf(terminal.eventName),
          ...(reasonCode !== null ? { attributes: { reasonCode: reasonCode.slice(0, 200) } } : {}),
          ...(result !== null
            ? {
                metrics: {
                  disposition: result.disposition,
                  criteriaMet: result.criteria.filter((criterion) => criterion.status === "met").length,
                  criteriaTotal: result.criteria.length,
                  artifactCount: result.artifacts.length,
                  recommendedNextAction: result.recommendedNextAction,
                },
              }
            : {}),
        },
      },
      { actor: subagentActor(runId), executor: subagentExecutor(runId) },
    );
    if (this.deps.runs !== undefined && ownership !== null) {
      try {
        const run = this.deps.runs.get(runId, ownership);
        if (run !== null) {
          this.replay?.publish(threadId, { kind: "run", run });
        }
      } catch {
        // 终态后 Run 读取失败：跳过 replay（Activity 已写）
      }
    }
    // 终态 result 协议消息：host 只回调 onTerminal，不回调 onMessage——
    // 投影层补一条 message.queued + replay message（保证面板流消息完整）
    if (this.deps.messages !== undefined && ownership !== null) {
      try {
        const records = this.deps.messages.listByRun(runId, ownership);
        const resultMessage = records.find((record) => record.messageType === "result");
        if (resultMessage !== undefined) {
          this.projectMessage(resultMessage);
        }
      } catch {
        // 读取失败跳过（Activity 已写）
      }
    }
  }

  /** 协议消息投影：message.queued（routine）+ progress/input_required 事件 + replay */
  projectMessage(message: SubagentMessageRecord): void {
    const ownership = this.ownershipOf(message.threadId);
    this.threadByRun.set(message.runId, message.threadId);
    if (message.envelope.metadata.traceId !== "" && !this.traceByRun.has(message.runId)) {
      this.traceByRun.set(message.runId, message.envelope.metadata.traceId);
    }
    this.activity(
      {
        eventName: "subagent.message.queued",
        threadId: message.threadId,
        runId: message.runId,
        ownership,
        payload: {
          summaryCode: "subagent_message_queued",
          attributes: {
            messageType: message.messageType,
            sequence: message.sequence,
            deliveryMode: message.deliveryMode,
            senderKind: message.senderKind,
          },
        },
      },
      { actor: senderActorOf(message), executor: serviceExecutor() },
    );
    if (message.messageType === "progress") {
      this.projectRunProgress(message.runId, phaseOf(message), message.threadId);
    } else if (message.messageType === "input_required") {
      this.projectInputRequired(message.runId, message.threadId, textOf(message));
    }
    this.replay?.publish(message.threadId, { kind: "message", message });
  }

  /** T5 Dispatcher 投递成功时调用（queued → delivered） */
  projectMessageDelivered(messageId: AgentMessageId, threadId: SubagentThreadId, runId: SubagentRunId): void {
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName: "subagent.message.delivered",
        threadId,
        runId,
        ownership,
        payload: { summaryCode: "subagent_message_delivered", resultRef: messageId },
      },
      { actor: systemActor("subagent-runtime"), executor: serviceExecutor() },
    );
  }

  projectSteerQueued(threadId: SubagentThreadId, runId: SubagentRunId, action: string): void {
    this.steerEvent("subagent.steer.queued", threadId, runId, action);
  }

  projectSteerApplied(threadId: SubagentThreadId, runId: SubagentRunId, action: string): void {
    this.steerEvent("subagent.steer.applied", threadId, runId, action);
  }

  projectSteerFailed(threadId: SubagentThreadId, runId: SubagentRunId, action: string, reasonCode: string): void {
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName: "subagent.steer.failed",
        threadId,
        runId,
        ownership,
        payload: {
          summaryCode: "subagent_steer_failed",
          attributes: { action: action.slice(0, 64), reasonCode: reasonCode.slice(0, 200) },
        },
      },
      {
        actor: ownership !== null ? parentAgentActor(ownership.ownerAgentId) : systemActor("subagent-runtime"),
        executor: serviceExecutor(),
      },
    );
  }

  /** T5 Parent Mailbox 投递状态投影（queued=point、completed/failed=terminal、suppressed=point） */
  projectParentDelivery(
    notificationKind: ParentMailboxNotificationKind,
    record: ParentMailboxRecord,
    ownership: SubagentOwnership,
  ): void {
    const eventName =
      record.status === "queued"
        ? "subagent.parent_delivery.queued"
        : record.status === "delivered"
          ? "subagent.parent_delivery.completed"
          : record.status === "suppressed"
            ? "subagent.parent_delivery.suppressed"
            : "subagent.parent_delivery.failed";
    const payload: ActivityPayload = {
      summaryCode: summaryCodeOf(eventName),
      attributes: {
        notificationKind,
        triggerParentTurn: record.triggerParentTurn ? 1 : 0,
        ...(record.lastErrorCode !== null ? { lastErrorCode: record.lastErrorCode.slice(0, 200) } : {}),
      },
    };
    const input: ActivityRecordInput = {
      eventName,
      payload,
      actor: parentAgentActor(ownership.ownerAgentId),
      executor: serviceExecutor(),
      scope: this.scopeOf(record.threadId, record.runId, ownership),
      ...(eventName.endsWith(".completed") || eventName.endsWith(".failed")
        ? { status: eventName.endsWith(".failed") ? "failed" : "completed", operationId: `subagent-delivery-${record.mailboxId}` }
        : {}),
    };
    this.tryRecord(input, record.threadId, record.runId, ownership);
  }

  projectArtifactCreated(record: SubagentArtifactRecord, ownership: SubagentOwnership): void {
    this.activity(
      {
        eventName: "subagent.artifact.created",
        threadId: record.threadId,
        runId: record.runId,
        ownership,
        payload: {
          summaryCode: "subagent_artifact_created",
          attributes: {
            kind: record.kind.slice(0, 32),
            resourceKind: record.resourceKind.slice(0, 32),
            sizeBytes: record.sizeBytes ?? 0,
            visibility: record.visibility,
          },
          resultRef: record.artifactId,
        },
        target: { kind: "subagent_artifact", id: record.artifactId },
      },
      { actor: parentAgentActor(ownership.ownerAgentId), executor: subagentExecutor(record.runId) },
    );
  }

  projectArtifactIntegrityFailed(event: {
    readonly artifactId: string;
    readonly threadId: SubagentThreadId;
    readonly runId: SubagentRunId | null;
    readonly expectedHash: string;
    readonly reason: string;
  }): void {
    const ownership = this.ownershipOf(event.threadId);
    this.activity(
      {
        eventName: "subagent.artifact.integrity_failed",
        threadId: event.threadId,
        runId: event.runId,
        ownership,
        payload: {
          summaryCode: "subagent_artifact_integrity_failed",
          attributes: { reason: event.reason.slice(0, 200) },
          resultRef: event.artifactId,
        },
        target: { kind: "subagent_artifact", id: event.artifactId },
      },
      { actor: systemActor("subagent-runtime"), executor: serviceExecutor() },
    );
  }

  /** Tool delta（§17.2：不落 durable Activity，只走 replay 面板流） */
  projectToolActivity(view: SubagentToolActivityView): void {
    this.replay?.publish(view.threadId, { kind: "tool", tool: view });
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  private steerEvent(eventName: "subagent.steer.queued" | "subagent.steer.applied", threadId: SubagentThreadId, runId: SubagentRunId, action: string): void {
    const ownership = this.ownershipOf(threadId);
    this.activity(
      {
        eventName,
        threadId,
        runId,
        ownership,
        payload: { summaryCode: summaryCodeOf(eventName), attributes: { action: action.slice(0, 64) } },
      },
      {
        actor: ownership !== null ? parentAgentActor(ownership.ownerAgentId) : systemActor("subagent-runtime"),
        executor: serviceExecutor(),
      },
    );
  }

  private activity(
    input: {
      readonly eventName: string;
      readonly threadId: SubagentThreadId | null;
      readonly runId: SubagentRunId | null;
      readonly ownership: SubagentOwnership | null;
      readonly trace?: TraceContext;
      readonly status?: "started" | "processing" | "completed" | "failed" | "cancelled" | "interrupted" | "degraded";
      readonly operationId?: string;
      readonly payload: ActivityPayload;
      readonly target?: ResourceRef;
    },
    identity: { readonly actor: ActorRef; readonly executor: ExecutorRef },
  ): void {
    const record: ActivityRecordInput = {
      eventName: input.eventName,
      payload: input.payload,
      actor: identity.actor,
      executor: identity.executor,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      ...(input.threadId !== null
        ? {
            scope: this.scopeOf(input.threadId, input.runId, input.ownership),
            trace: input.trace ?? this.traceOf(input.threadId, input.runId),
          }
        : {}),
    };
    this.tryRecord(record, input.threadId, input.runId, input.ownership);
  }

  private tryRecord(record: ActivityRecordInput, threadId: SubagentThreadId | null, runId: SubagentRunId | null, ownership: SubagentOwnership | null): void {
    try {
      this.deps.activity.append(record);
    } catch {
      // best-effort：投影失败不阻断 Runtime（T4 回调契约）；T9b：把证据交给
      // 调用方持久为 auditPending（§19.3 补账），持久化自身失败不阻断
      try {
        this.deps.onProjectionFailure?.({ record, threadId, runId, ownership });
      } catch {
        // auditPending 持久失败：静默（恢复器无法补账，诊断由调用方负责）
      }
    }
  }

  private scopeOf(threadId: SubagentThreadId, runId: SubagentRunId | null, ownership: SubagentOwnership | null): EventScope {
    return {
      ...(ownership !== null ? { ownerAgentId: ownership.ownerAgentId, sessionId: ownership.parentSessionId } : {}),
      subagentThreadId: threadId,
      ...(runId !== null ? { subagentRunId: runId } : {}),
    };
  }

  /**
   * 默认 trace：Run 生命周期事件（queued/started/terminal）共享确定性 run spanId
   * （traceTree 按 spanId 合并 started+terminal）；消息/工具事件为 run span 的子 span。
   */
  private traceOf(threadId: SubagentThreadId, runId: SubagentRunId | null): TraceContext {
    const traceId = (runId !== null ? this.traceByRun.get(runId) : undefined) ?? `trace-${runId ?? threadId}`;
    if (runId === null) {
      return { traceId, spanId: newSpanId() };
    }
    return {
      traceId,
      spanId: runSpanId(runId),
      operationId: `subagent-run-${runId}`,
    };
  }

  private ownershipOf(threadId: SubagentThreadId | null): SubagentOwnership | null {
    if (threadId === null) return null;
    return this.ownershipByThread.get(threadId) ?? null;
  }
}

/**
 * host 回调 → projector 接线（§十三 T7：observability 投影从此处接线）。
 * 返回包装后的 deps；组合根用返回值构造 SubagentRuntimeHost：
 *   new SubagentRuntimeHost(wireSubagentRuntimeObservability(baseDeps, projector))
 * 已存在的同名回调会被先调用（链式，不覆盖 T5 的投影）。
 */
export function wireSubagentRuntimeObservability(
  deps: SubagentRuntimeHostDeps,
  projector: SubagentObservabilityProjector,
): SubagentRuntimeHostDeps {
  const previous = {
    onRunProgress: deps.onRunProgress,
    onMessage: deps.onMessage,
    onTerminal: deps.onTerminal,
    onLeaseLost: deps.onLeaseLost,
  };
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // best-effort：投影失败不阻断 Runtime
    }
  };
  return {
    ...deps,
    onRunProgress: (event) => {
      safe(() => previous.onRunProgress?.(event));
      safe(() => projector.onRunProgress(event));
    },
    onMessage: (event) => {
      safe(() => previous.onMessage?.(event));
      safe(() => projector.onMessage(event));
    },
    onTerminal: (event) => {
      safe(() => previous.onTerminal?.(event));
      safe(() => projector.onTerminal(event));
    },
    onLeaseLost: (event) => {
      safe(() => previous.onLeaseLost?.(event));
      safe(() => projector.onLeaseLost(event));
    },
  };
}

// ── 身份 helpers（§19.1 / §19.3：Actor=父 Agent 或 Subagent；Executor=service 或 subagent）──

function parentAgentActor(ownerAgentId: string): ActorRef {
  return { kind: "agent", id: ownerAgentId };
}

function subagentActor(runId: SubagentRunId): ActorRef {
  return { kind: "subagent", id: runId };
}

function systemActor(id: string): ActorRef {
  return { kind: "system", id };
}

function serviceExecutor(): ExecutorRef {
  return { kind: "service", id: "subagent-runtime" };
}

function subagentExecutor(runId: SubagentRunId): ExecutorRef {
  return { kind: "subagent", id: runId };
}

function systemExecutor(id: string): ExecutorRef {
  return { kind: "system", id };
}

function senderActorOf(message: SubagentMessageRecord): ActorRef {
  const sender = message.envelope.sender;
  switch (sender.kind) {
    case "parent_agent":
      return { kind: "agent", id: sender.id };
    case "subagent":
      return { kind: "subagent", id: sender.id };
    case "system":
      return { kind: "system", id: sender.id };
  }
}

function textOf(message: SubagentMessageRecord): string {
  for (const part of message.envelope.parts) {
    if (part.kind === "text") return part.text;
  }
  return "";
}

/** progress 消息的 phase：T4 约定 parts 首 text 即阶段文本；无 phase 时 undefined */
function phaseOf(message: SubagentMessageRecord): string | undefined {
  const text = textOf(message);
  return text !== "" ? text.slice(0, 64) : undefined;
}
