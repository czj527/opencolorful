import { type SubagentRunId } from "../../../contracts/subagents.js";
import type { ExecuteSubagentRunInput, SubagentRuntimeHost } from "./runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T4：SubagentScheduler（plans/phase-14.md §15.1 / §22.2）
//
// 容量控制（平台常量，不在 Phase 14 Web 设置暴露，§16.4）：
// - 同时执行（active）缺省 2；容量满 → 按 FIFO 排队（Run 在 DB 保持
//   queued，恢复语义不变）；
// - 排队上限（队列积压失控保护）→ 拒绝并返回稳定诊断
//   subagent_runtime_unavailable（§22.2：capacity 无法可靠入队，fail-closed，
//   不允许创建无人执行的 Run）；
// - 终态回调（host.onTerminal）释放容量并启动下一个排队 Run；
// - shutdown：清空内存队列（排队 Run 仍为 DB queued 状态，由下一 boot
//   的启动恢复接管，不在这里终态化——queued → failed 非法转换）。
// ═══════════════════════════════════════════════════════════════

/** 同时执行上限（§15.1：平台常量） */
export const SUBAGENT_SCHEDULER_DEFAULT_CAPACITY = 2;
/** 排队上限（超过即拒绝；Run 保持 queued 由恢复接管不在此列） */
export const SUBAGENT_SCHEDULER_MAX_QUEUE = 8;

export interface SubagentSchedulerDeps {
  readonly host: SubagentRuntimeHost;
  readonly capacity?: number;
}

export type SubmitSubagentRunResult =
  | { readonly status: "accepted"; readonly queued: boolean }
  | { readonly status: "rejected"; readonly reasonCode: string; readonly reason: string };

export class SubagentScheduler {
  private readonly capacity: number;
  private readonly queue: ExecuteSubagentRunInput[] = [];

  constructor(private readonly deps: SubagentSchedulerDeps) {
    this.capacity = deps.capacity ?? SUBAGENT_SCHEDULER_DEFAULT_CAPACITY;
  }

  get activeCount(): number {
    return this.deps.host.activeRunCount;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  isScheduled(runId: SubagentRunId): boolean {
    return this.deps.host.isRunActive(runId) || this.queue.some((queued) => queued.runId === runId);
  }

  /**
   * 提交 Run 执行：容量未满立即交给 Host；满则排队（FIFO）。
   * 同一 Run 重复提交拒绝（内存去重；DB 状态冲突由 Host 的
   * startWithSnapshot CAS 兜底）。
   */
  submit(input: ExecuteSubagentRunInput): SubmitSubagentRunResult {
    if (this.isScheduled(input.runId)) {
      return {
        status: "rejected",
        reasonCode: "subagent_run_state_conflict",
        reason: `Run ${input.runId} 已在本 Server 提交（执行中或排队中）`,
      };
    }
    if (this.deps.host.activeRunCount < this.capacity) {
      this.deps.host.execute(input);
      return { status: "accepted", queued: false };
    }
    if (this.queue.length >= SUBAGENT_SCHEDULER_MAX_QUEUE) {
      return {
        status: "rejected",
        reasonCode: "subagent_runtime_unavailable",
        reason: `Subagent 运行时排队积压超过上限（${SUBAGENT_SCHEDULER_MAX_QUEUE}），无法可靠入队`,
      };
    }
    this.queue.push(input);
    return { status: "accepted", queued: true };
  }

  /**
   * Host Run 完全清理后回调（host.onRunFinished 接线；此刻 active 已移除、
   * 容量真实释放）：按 FIFO 启动排队 Run（best-effort）。
   */
  onRunTerminal(): void {
    while (this.deps.host.activeRunCount < this.capacity && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) {
        break;
      }
      const outcome = this.deps.host.execute(next);
      if (outcome.status === "rejected") {
        // 理论不可达（submit 时已去重）；防御：不再重试，避免活锁
        continue;
      }
    }
  }

  /** 清空内存队列（关闭/重启；DB queued Run 由启动恢复接管） */
  drain(): void {
    this.queue.length = 0;
  }
}
