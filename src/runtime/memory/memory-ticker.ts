import crypto from "node:crypto";
import path from "node:path";

import type { AgentStore } from "../../config/agent-store.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { EventReplayStore } from "../event-replay-store.js";
import type { PromptService } from "../prompt-service.js";
import type { SessionService } from "../session-service.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryWatermarkStore, SchedulerStateStore } from "../../storage/memory/recovery-store.js";
import type { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import type { RollingSummaryService } from "./rolling-summary.js";
import type { EventIndexer } from "./event-indexer.js";
import type { MemoryCompilePipeline } from "./compile-pipeline.js";
import { getLogicalDate } from "./memory-files.js";
import { readSessionBranchSnapshot } from "./jsonl-branch-reader.js";

export interface MemoryTickerOptions {
  readonly idleMs?: number;
  readonly tickMs?: number;
  readonly now?: () => number;
}

export interface MemoryTickerDeps {
  readonly replayStore: EventReplayStore;
  readonly sessionService: SessionService;
  readonly promptService: PromptService;
  readonly agentStore: AgentStore;
  readonly summaryStore: SessionSummaryStore;
  readonly batchStore: MemoryBatchStore;
  readonly watermarkStore: MemoryWatermarkStore;
  readonly schedulerStore: SchedulerStateStore;
  readonly rollingSummary: Pick<RollingSummaryService, "maybeSummarize">;
  readonly eventIndexer: Pick<EventIndexer, "indexSession">;
  /** T4 四段 Markdown 编译流水线（每 10 轮 refreshToday；跨日 runDaily） */
  readonly compilePipeline: Pick<MemoryCompilePipeline, "refreshToday" | "runDaily">;
  /** agents 根目录，用于定位 <agentId>/memory/ */
  readonly agentsDir: string;
  readonly options?: MemoryTickerOptions;
  /** turn.completed 后的去抖窗口；默认 10 轮触发一次 */
  readonly turnsPerSummary?: number;
}

export type MemoryTickerRunStatus = "updated" | "degraded" | "failed" | "skipped";

export interface MemoryTickerRunResult {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: MemoryTickerRunStatus;
  readonly batchId?: string;
  readonly reason?: string;
}

/**
 * Phase 10 的近期记忆后台协调器。
 *
 * 它只负责把 turn.completed 变成近期摘要、事件索引和 sealed batch；
 * 不运行记忆 Agent，也不写 memory_facts。每个 Agent 使用串行 promise tail，
 * 后台失败不会冒泡到主对话。
 */
export class MemoryTicker {
  private readonly unsubscribe: () => void;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly queued = new Set<string>();
  private readonly lastActivity = new Map<string, number>();
  private readonly turnCounts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: MemoryTickerDeps) {
    this.unsubscribe = deps.replayStore.subscribe((event) => this.onEvent(event));
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const interval = this.deps.options?.tickMs ?? 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.housekeeping();
    }, interval);
    void this.recoverDirty();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 测试/关闭前等待当前 per-agent 队列排空。 */
  async flush(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }

  private onEvent(event: PlatformEventEnvelope): void {
    if (event.sessionId === null) return;
    const now = this.deps.options?.now?.() ?? Date.now();
    this.lastActivity.set(event.sessionId, now);
    if (event.type !== "turn.completed") return;
    const view = this.safeView(event.sessionId);
    if (!view?.agentId || view.archived) return;
    const count = (this.turnCounts.get(event.sessionId) ?? 0) + 1;
    this.turnCounts.set(event.sessionId, count);
    const threshold = this.deps.turnsPerSummary ?? 10;
    if (count % threshold === 0) {
      this.enqueue(view.agentId, event.sessionId, "turn.completed");
    }
  }

  private safeView(sessionId: string) {
    try {
      return this.deps.sessionService.getView(sessionId);
    } catch {
      return undefined;
    }
  }

  private enqueue(agentId: string, sessionId: string, reason: string, priority = 0): void {
    const key = `${agentId}:${sessionId}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.process(agentId, sessionId, reason, priority);
        } finally {
          this.queued.delete(key);
        }
      });
    this.tails.set(agentId, next);
    void next.catch(() => undefined);
  }

  /**
   * Session 归档触发：立即补摘要并创建高优先级 sealed batch（fire-and-forget）。
   * 由 SessionService.archive 的 onArchive 钩子调用。
   */
  onSessionArchived(sessionId: string): void {
    const view = this.safeView(sessionId);
    if (!view?.agentId) return;
    this.enqueue(view.agentId, sessionId, "archive", 1);
  }

  /**
   * 手动 flush（Phase 10）：封存所有活跃 Session + 重建 Markdown/事件索引。
   * 只做近期整理，不运行记忆 Agent、不应用长期事实 proposal。
   */
  requestFlush(agentId: string): void {
    for (const view of this.deps.sessionService.list({ agentId })) {
      if (!view.archived) this.enqueue(agentId, view.id, "flush", 1);
    }
    void this.runDailyIfNeeded(agentId);
  }

  private async process(
    agentId: string,
    sessionId: string,
    reason: string,
    priority = 0,
  ): Promise<MemoryTickerRunResult> {
    const view = this.safeView(sessionId);
    // 归档钩子在索引标记 archived 后才开始异步处理；归档批次仍必须读取
    // 该 Session 的最终 JSONL 快照，其他后台路径则继续拒绝已归档会话。
    if (!view?.agentId || view.agentId !== agentId || (view.archived && reason !== "archive")) {
      return { sessionId, agentId, status: "skipped", reason: "会话未绑定 Agent 或已归档" };
    }
    const summary = await this.deps.rollingSummary.maybeSummarize({
      agentId,
      sessionId,
      sessionPath: view.sessionPath,
    });
    if (summary.status === "skipped") {
      return { sessionId, agentId, status: "skipped", reason: summary.reason };
    }
    // 摘要尚未成功时不能封存一个没有稳定 summary revision 的 batch；
    // watermark 已由 RollingSummaryService 标记 dirty，后续 recovery 重试。
    if (summary.status === "degraded" || summary.status === "failed") {
      return { sessionId, agentId, status: summary.status, reason: summary.reason };
    }

    const latest = this.deps.summaryStore.getLatestForSession(sessionId);
    const indexed = this.deps.eventIndexer.indexSession({
      agentId,
      sessionId,
      sessionPath: view.sessionPath,
      ...(latest ? { summary: latest } : {}),
    });
    if (indexed.status === "skipped") {
      return { sessionId, agentId, status: "failed", reason: indexed.reason };
    }
    if (indexed.status === "degraded") {
      this.deps.watermarkStore.markDirty(agentId, "events", latest?.branchRevision ?? "");
    }

    const snapshot = readSessionBranchSnapshot(view.sessionPath);
    const entries = snapshot?.entries ?? [];
    const startEntry = latest?.sourceStartEntry ?? entries[0]?.id;
    const endEntry = latest?.sourceEndEntry ?? entries[entries.length - 1]?.id;
    const revision = latest?.branchRevision ?? "";
    if (!startEntry || !endEntry) {
      return { sessionId, agentId, status: summary.status === "updated" ? "skipped" : summary.status, reason: "没有可封存的 entry" };
    }

    const batchId = `batch_${crypto.createHash("sha256").update(`${agentId}:${sessionId}:${revision}:${startEntry}:${endEntry}`).digest("hex").slice(0, 20)}`;
    const exists = this.deps.batchStore.listByAgent(agentId).some((batch) => batch.id === batchId);
    if (!exists) {
      this.deps.batchStore.createBatch({
        id: batchId,
        agentId,
        sessionId,
        revision: { branchRevision: revision, cursor: latest?.cursor ?? {} },
        sourceStartEntry: startEntry,
        sourceEndEntry: endEntry,
        priority,
      }, "sealed");
    }

    // 每 10 轮/封存后：重新编译 today.md + assemble memory.md（LLM 不可用时
    // S4 assemble 仍执行，四段用上一版/占位符拼装）
    const memoryDir = path.join(this.deps.agentsDir, agentId, "memory");
    await this.deps.compilePipeline.refreshToday(agentId, memoryDir).catch(() => undefined);

    return {
      sessionId,
      agentId,
      status: summary.status === "updated" ? "updated" : summary.status,
      batchId,
      ...(summary.status !== "updated" ? { reason: summary.reason } : {}),
    };
  }

  /** 跨日边界：scheduler_state.lastDailyDate ≠ 今日时执行 S0-S4 每日整理 */
  private async runDailyIfNeeded(agentId: string): Promise<void> {
    const today = getLogicalDate();
    const state = this.deps.schedulerStore.get(agentId);
    if (state?.lastDailyDate === today) return;
    if (state?.nextRetryAt !== undefined && Date.parse(state.nextRetryAt) > Date.now()) return;
    const memoryDir = path.join(this.deps.agentsDir, agentId, "memory");
    const result = await this.deps.compilePipeline.runDaily(agentId, memoryDir, today).catch((error) => ({
      date: today,
      revision: "",
      degraded: true,
      completed: [],
      failures: [{ step: "S0" as const, error: error instanceof Error ? error.message : String(error) }],
    }));
    if (result.degraded || result.failures.length > 0) {
      this.deps.schedulerStore.upsert({
        agentId,
        status: "failed",
        ...(state?.lastDailyDate !== undefined ? { lastDailyDate: state.lastDailyDate } : {}),
        ...(state?.lastDailyCompletedAt !== undefined ? { lastDailyCompletedAt: state.lastDailyCompletedAt } : {}),
        ...(state?.lastWeeklyCompletedAt !== undefined ? { lastWeeklyCompletedAt: state.lastWeeklyCompletedAt } : {}),
        nextRetryAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    this.deps.schedulerStore.upsert({
      agentId,
      status: "idle",
      ...(state?.lastDailyCompletedAt !== undefined ? { lastDailyCompletedAt: state.lastDailyCompletedAt } : {}),
      ...(state?.lastWeeklyCompletedAt !== undefined ? { lastWeeklyCompletedAt: state.lastWeeklyCompletedAt } : {}),
      lastDailyDate: today,
      lastDailyCompletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  private async housekeeping(): Promise<void> {
    if (this.stopped) return;
    const now = this.deps.options?.now?.() ?? Date.now();
    const idleMs = this.deps.options?.idleMs ?? 30 * 60 * 1000;
    for (const agent of this.deps.agentStore.list()) {
      const agentId = agent.identity.id;
      void this.runDailyIfNeeded(agentId);
      for (const view of this.deps.sessionService.list({ agentId })) {
        if (view.archived || this.deps.promptService.isBusy(view.id)) continue;
        const last = this.lastActivity.get(view.id);
        if (last !== undefined && now - last < idleMs) continue;
        this.enqueue(agentId, view.id, "idle");
      }
    }
  }

  private async recoverDirty(): Promise<void> {
    for (const agent of this.deps.agentStore.list()) {
      const agentId = agent.identity.id;
      for (const dirty of this.deps.watermarkStore.listDirty(agentId)) {
        if (dirty.scope !== "summary" && dirty.scope !== "events" && dirty.scope !== "batch") continue;
        for (const view of this.deps.sessionService.list({ agentId })) {
          if (!view.archived) this.enqueue(agentId, view.id, "recovery");
        }
      }
      for (const batch of this.deps.batchStore.listPendingBatches(agentId)) {
        if (!this.safeView(batch.sessionId)?.archived) this.enqueue(agentId, batch.sessionId, "batch-recovery");
      }
    }
  }
}
