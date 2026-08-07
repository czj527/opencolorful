import type {
  ParentContinuationInput,
  ParentContinuationOutcome,
  ParentSessionPort,
  ParentSessionPortEvents,
  ParentSessionStatus,
} from "../mailbox/parent-session-port.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：父 SessionRuntime 适配器（plans/phase-14.md §14.2 / §T5 交付 2）
//
// 把主 Agent 的 SessionRuntime（Phase 13 主会话循环）适配为 ParentSessionPort：
// - 复用现有注入路径（SessionRuntime.prompt），不新建平行调度器；
// - "空闲且可运行"判定：activeStream() 为空（无 in-flight prompt/steer）、
//   无未消费 abort（noteUserAbort 后直到下一条用户消息消费）、未归档/删除
//   （getSessionState 由 T6 从 SessionIndex 注入）；
// - 用户消息优先：noteUserMessage() 中止 in-flight continuation（不插队），
//   用户消息赢得 prompt 槽；prompt 被占用时 startContinuation 返回
//   rejected/parent_session_busy；
// - 同一 Session 至多一个并发 continuation（内部 guard + 协调器记账）；
// - 终态语义：continuation 正常结束 → triggered；被用户打断 → interrupted
//   （Turn 已触发一次，不重复触发）；未触发 → rejected（可重试）。
//
// 生产接线（T6 组合根）：把主 Session 的 SessionRuntime 实例传入（结构性
// 匹配 facade：prompt/activeStream/abort）；测试注入 Faux facade。
// ═══════════════════════════════════════════════════════════════

/**
 * SessionRuntime 公共 API 的窄面（与 SessionRuntime 结构兼容：
 * prompt() → { streamId, completed }、activeStream()、abort()）。
 */
export interface ParentSessionRuntimeFacade {
  readonly sessionId: string;
  activeStream(): string | undefined;
  prompt(text: string): { readonly streamId: string; readonly completed: Promise<void> };
  abort(streamId: string): unknown;
}

export interface SessionRuntimeParentSessionPortOptions {
  readonly runtime: ParentSessionRuntimeFacade;
  /** 归属 Agent（ownerAgentId 语义） */
  readonly ownerAgentId: string;
  /** 会话状态来源（归档/删除由 SessionIndex/SessionService 维护；T6 注入） */
  readonly getSessionState?: () => "active" | "archived" | "deleted";
}

export class SessionRuntimeParentSessionPort implements ParentSessionPort {
  private readonly subscribers = new Set<ParentSessionPortEvents>();
  /** 用户 stop 后未消费 abort（下一条用户消息消费；期间不自动 continuation） */
  private abortPending = false;
  /** in-flight continuation（内部 guard：同一 Session 至多一个并发） */
  private continuation: { readonly streamId: string; readonly operationId: string; interrupted: boolean } | null = null;

  constructor(private readonly options: SessionRuntimeParentSessionPortOptions) {}

  get sessionId(): string {
    return this.options.runtime.sessionId;
  }

  get ownerAgentId(): string {
    return this.options.ownerAgentId;
  }

  getStatus(): ParentSessionStatus {
    const state = this.options.getSessionState?.() ?? "active";
    if (state === "archived") return "archived";
    if (state === "deleted") return "deleted";
    if (this.options.runtime.activeStream() !== undefined) return "busy";
    return "idle";
  }

  /** "空闲且可运行"：无 in-flight prompt/steer、无未消费 abort、未归档/删除（§T5 交付 2） */
  isIdleAndRunnable(): boolean {
    return this.getStatus() === "idle" && !this.abortPending && this.continuation === null;
  }

  async startContinuation(input: ParentContinuationInput): Promise<ParentContinuationOutcome> {
    if (this.continuation !== null) {
      return { status: "rejected", reasonCode: "parent_continuation_in_flight" };
    }
    if (!this.isIdleAndRunnable()) {
      return { status: "rejected", reasonCode: this.rejectionReason() };
    }
    let run: { streamId: string; completed: Promise<void> };
    try {
      run = this.options.runtime.prompt(input.text);
    } catch {
      // 竞态：用户消息已抢先占用 prompt 槽（用户优先，continuation 不插队）
      return { status: "rejected", reasonCode: "parent_session_busy" };
    }
    this.continuation = { streamId: run.streamId, operationId: input.operationId, interrupted: false };
    try {
      await run.completed;
    } catch {
      // completed 由 ExecutionRegistry.finish 总是 resolve（abort 也 resolve）；防御
    }
    const continuation = this.continuation;
    this.continuation = null;
    return continuation.interrupted
      ? { status: "interrupted" }
      : { status: "triggered" };
  }

  noteUserMessage(): void {
    this.abortPending = false; // 用户新消息消费未消费 abort
    const continuation = this.continuation;
    if (continuation !== null) {
      continuation.interrupted = true;
      try {
        this.options.runtime.abort(continuation.streamId);
      } catch {
        // 已结束：忽略
      }
      this.emit("onUserInterrupt");
    }
  }

  noteUserTurnEnd(): void {
    this.emit("onTurnEnd");
  }

  noteUserAbort(): void {
    this.abortPending = true; // stop：未消费 abort 期间不自动 continuation
    this.emit("onUserInterrupt");
  }

  subscribe(events: ParentSessionPortEvents): () => void {
    this.subscribers.add(events);
    return () => {
      this.subscribers.delete(events);
    };
  }

  private rejectionReason(): string {
    const status = this.getStatus();
    if (status === "archived") return "parent_session_archived";
    if (status === "deleted") return "parent_session_deleted";
    if (status === "busy") return "parent_session_busy";
    if (status === "unknown") return "parent_session_unknown";
    if (this.abortPending) return "parent_session_abort_pending";
    if (this.continuation !== null) return "parent_continuation_in_flight";
    return "parent_session_busy";
  }

  private emit(kind: keyof ParentSessionPortEvents): void {
    for (const events of [...this.subscribers]) {
      if (kind === "onUserInterrupt") {
        events.onUserInterrupt();
      } else {
        events.onTurnEnd();
      }
    }
  }
}
