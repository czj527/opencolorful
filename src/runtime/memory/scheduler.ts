// ═══════════════════════════════════════════════════════════════
// MemoryAgentScheduler（plans/phase-10.5.md §三）
//
// 调度规则：
// - 每日窗口：本地时间 ≥ dailyRunTime（默认 03:00）且 Agent 空闲
//   ≥ minIdleMinutes 才运行记忆 Agent；活动时跳过，下次 housekeeping tick 重试
// - 每周复核：weeklyReviewDay(0=周日) + weeklyReviewTime（默认 03:30）独立运行
// - 高优先级 intent：turn.completed 后若存在 priority>0 的 pending intent，
//   立即创建 bounded micro-seal（不关闭 Session）并触发专项整理（仍经 MemoryPolicy）
// - 失败/延期：scheduler_state.nextRetryAt 到期后重试；半成品对主 Agent 不可见
//
// 每 Agent 独立串行（resolver 调用方负责，scheduler 用 per-agent promise tail）。
// ═══════════════════════════════════════════════════════════════

import type { AgentStore } from "../../config/agent-store.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { MemoryAgentSettings } from "../../contracts/memory.js";
import type { EventReplayStore } from "../event-replay-store.js";
import type { PromptService } from "../prompt-service.js";
import type { SessionService } from "../session-service.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { SchedulerStateStore } from "../../storage/memory/recovery-store.js";
import type { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import type { MemoryAgentResolver } from "./resolver.js";
import { readSessionBranchSnapshot } from "./jsonl-branch-reader.js";
import crypto from "node:crypto";

export interface MemoryAgentSchedulerDeps {
  readonly replayStore: EventReplayStore;
  readonly sessionService: SessionService;
  readonly promptService: PromptService;
  readonly agentStore: AgentStore;
  readonly journalStore: MemoryJournalStore;
  readonly batchStore: MemoryBatchStore;
  readonly summaryStore: SessionSummaryStore;
  readonly schedulerStore: SchedulerStateStore;
  readonly settingsResolver: (agentId: string) => MemoryAgentSettings;
  readonly resolver: Pick<MemoryAgentResolver, "runMaintenance" | "deepDive">;
  readonly tickMs?: number;
  readonly now?: () => Date;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export class MemoryAgentScheduler {
  private readonly unsubscribe: () => void;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastActivity = new Map<string, number>();
  private readonly doneMaintenanceDates = new Map<string, string>();
  private readonly doneWeeklyDates = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: MemoryAgentSchedulerDeps) {
    this.unsubscribe = deps.replayStore.subscribe((event) => this.onEvent(event));
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const interval = this.deps.tickMs ?? 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 测试/关闭前等待队列排空 */
  async flush(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }

  private onEvent(event: PlatformEventEnvelope): void {
    if (event.sessionId === null) return;
    const now = this.deps.now?.() ?? new Date();
    this.lastActivity.set(event.sessionId, now.getTime());
    if (event.type !== "turn.completed") return;
    // 高优先级 intent：turn 完成后立即 micro-seal + 专项整理
    const view = this.safeView(event.sessionId);
    if (!view?.agentId || view.archived) return;
    const agentId = view.agentId;
    if (!this.deps.settingsResolver(agentId).enabled) return;
    const hasHighPriority = this.deps.journalStore
      .listPending(agentId)
      .some((intent) => (intent.priority ?? 0) > 0);
    if (hasHighPriority) {
      this.enqueueAgent(agentId, async () => {
        await this.createMicroSeal(agentId, view.id);
        await this.deps.resolver.runMaintenance(agentId);
      });
    }
  }

  private safeView(sessionId: string) {
    try {
      return this.deps.sessionService.getView(sessionId);
    } catch {
      return undefined;
    }
  }

  private enqueueAgent(agentId: string, task: () => Promise<void>): void {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.tails.set(agentId, next);
    void next.catch(() => undefined);
  }

  /**
   * 创建 bounded micro-seal：从最近 summary cursor 到当前 leaf 的 source range，
   * provisional 状态（长会话不关闭），由记忆 Agent 专项处理。
   */
  private async createMicroSeal(agentId: string, sessionId: string): Promise<void> {
    const view = this.safeView(sessionId);
    if (!view) return;
    const snapshot = readSessionBranchSnapshot(view.sessionPath);
    if (!snapshot) return;
    const latest = this.deps.summaryStore.getLatestForSession(sessionId);
    const startEntry = latest?.sourceEndEntry ?? snapshot.entries[0]?.id;
    const endEntry = snapshot.leafId;
    if (!startEntry || !endEntry) return;
    const batchId = `micro_${crypto.createHash("sha256")
      .update(`${agentId}:${sessionId}:${startEntry}:${endEntry}`)
      .digest("hex").slice(0, 20)}`;
    const exists = this.deps.batchStore.listByAgent(agentId).some((batch) => batch.id === batchId);
    if (exists) return;
    this.deps.batchStore.createBatch({
      id: batchId,
      agentId,
      sessionId,
      revision: { branchRevision: latest?.branchRevision ?? "", cursor: latest?.cursor ?? {} },
      sourceStartEntry: startEntry,
      sourceEndEntry: endEntry,
      priority: 1,
    }, "provisional");
  }

  /** housekeeping：每日/每周窗口 gate + nextRetryAt 重试 */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.deps.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const weekDay = now.getDay();

    for (const agent of this.deps.agentStore.list()) {
      const agentId = agent.identity.id;
      const settings = this.deps.settingsResolver(agentId);
      if (!settings.enabled) continue;
      const state = this.deps.schedulerStore.get(agentId);

      // nextRetryAt 未到期则跳过该 Agent
      if (state?.nextRetryAt !== undefined && Date.parse(state.nextRetryAt) > now.getTime()) continue;
      // 空闲 gate：所有会话不在忙 + 最后活动超过 minIdleMinutes
      if (!this.isAgentIdle(agentId, now, settings)) continue;

      const dailyDue =
        minutes >= minutesOf(settings.dailyRunTime) &&
        this.doneMaintenanceDates.get(agentId) !== today &&
        (state?.lastDailyCompletedAt ?? "").slice(0, 10) !== today;
      if (dailyDue) {
        this.enqueueAgent(agentId, async () => {
          // 闭包内重新读取 scheduler_state：daily/weekly 两个到期任务串行执行时，
          // 后完成的 upsert 必须以最新状态为准，否则会互相覆盖字段（评审 P1#4）
          const latest = this.deps.schedulerStore.get(agentId);
          const outcome = await this.deps.resolver.runMaintenance(agentId);
          if (outcome.status === "completed") {
            // 仅成功推进"今日已完成"；失败只设置 nextRetryAt，稍后 tick 自动重试
            this.doneMaintenanceDates.set(agentId, today);
            this.deps.schedulerStore.upsert({
              agentId,
              status: "idle",
              ...(latest?.lastDailyDate !== undefined ? { lastDailyDate: latest.lastDailyDate } : {}),
              lastDailyCompletedAt: nowIso,
              ...(latest?.lastWeeklyCompletedAt !== undefined ? { lastWeeklyCompletedAt: latest.lastWeeklyCompletedAt } : {}),
              updatedAt: nowIso,
            });
          } else {
            this.deps.schedulerStore.upsert({
              agentId,
              status: "failed",
              ...(latest?.lastDailyDate !== undefined ? { lastDailyDate: latest.lastDailyDate } : {}),
              ...(latest?.lastDailyCompletedAt !== undefined ? { lastDailyCompletedAt: latest.lastDailyCompletedAt } : {}),
              ...(latest?.lastWeeklyCompletedAt !== undefined ? { lastWeeklyCompletedAt: latest.lastWeeklyCompletedAt } : {}),
              nextRetryAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
              updatedAt: nowIso,
            });
          }
        });
      }

      const weeklyDue =
        weekDay === settings.weeklyReviewDay &&
        minutes >= minutesOf(settings.weeklyReviewTime) &&
        this.doneWeeklyDates.get(agentId) !== today &&
        (state?.lastWeeklyCompletedAt ?? "").slice(0, 10) !== today;
      if (weeklyDue) {
        this.enqueueAgent(agentId, async () => {
          // 同上：以最新 state 为基准 upsert，避免覆盖 daily 任务刚写入的字段
          const latest = this.deps.schedulerStore.get(agentId);
          const outcome = await this.deps.resolver.runMaintenance(agentId, { weekly: true });
          if (outcome.status === "completed") {
            this.doneWeeklyDates.set(agentId, today);
            this.deps.schedulerStore.upsert({
              agentId,
              status: "idle",
              ...(latest?.lastDailyDate !== undefined ? { lastDailyDate: latest.lastDailyDate } : {}),
              ...(latest?.lastDailyCompletedAt !== undefined ? { lastDailyCompletedAt: latest.lastDailyCompletedAt } : {}),
              lastWeeklyCompletedAt: nowIso,
              updatedAt: nowIso,
            });
          } else {
            // 每周复核失败同样不推进完成日期，设置重试
            this.deps.schedulerStore.upsert({
              agentId,
              status: "failed",
              ...(latest?.lastDailyDate !== undefined ? { lastDailyDate: latest.lastDailyDate } : {}),
              ...(latest?.lastDailyCompletedAt !== undefined ? { lastDailyCompletedAt: latest.lastDailyCompletedAt } : {}),
              ...(latest?.lastWeeklyCompletedAt !== undefined ? { lastWeeklyCompletedAt: latest.lastWeeklyCompletedAt } : {}),
              nextRetryAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
              updatedAt: nowIso,
            });
          }
        });
      }
    }
  }

  /**
   * 手动 deep-dive 入口：与定时任务共用 per-Agent promise tail，
   * 保证同一 Agent 的整理串行执行（并发点击/与定时重叠不会重复消化同一批 batches）。
   */
  async enqueueDeepDive(agentId: string, opts: { weekly?: boolean } = {}): Promise<unknown> {
    let resolved: unknown;
    this.enqueueAgent(agentId, async () => {
      resolved = await this.deps.resolver.runMaintenance(agentId, opts);
    });
    await this.flush();
    return resolved;
  }

  private isAgentIdle(agentId: string, now: Date, settings: MemoryAgentSettings): boolean {
    const idleMs = settings.minIdleMinutes * 60 * 1000;
    const sessions = this.deps.sessionService.list({ agentId });
    for (const view of sessions) {
      if (this.deps.promptService.isBusy(view.id)) return false;
      // 进程内最后活动（事件订阅）优先；重启后回退到持久化 SessionView.updatedAt，
      // 避免进程重启后的短暂"伪空闲"窗口误触发整理（评审 P1#5）
      const inProcess = this.lastActivity.get(view.id);
      const persisted = Date.parse(view.updatedAt);
      const last = Math.max(inProcess ?? 0, Number.isFinite(persisted) ? persisted : 0);
      if (last !== 0 && now.getTime() - last < idleMs) return false;
    }
    return true;
  }
}
