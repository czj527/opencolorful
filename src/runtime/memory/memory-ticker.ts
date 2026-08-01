import crypto from "node:crypto";

import type { AgentStore } from "../../config/agent-store.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { EventReplayStore } from "../event-replay-store.js";
import type { PromptService } from "../prompt-service.js";
import type { SessionService } from "../session-service.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import type { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import type { RollingSummaryService } from "./rolling-summary.js";
import type { EventIndexer } from "./event-indexer.js";
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
  readonly rollingSummary: RollingSummaryService;
  readonly eventIndexer: EventIndexer;
  readonly options?: MemoryTickerOptions;
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
    this.enqueue(view.agentId, event.sessionId, "turn.completed");
  }

  private safeView(sessionId: string) {
    try {
      return this.deps.sessionService.getView(sessionId);
    } catch {
      return undefined;
    }
  }

  private enqueue(agentId: string, sessionId: string, reason: string): void {
    const key = `${agentId}:${sessionId}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.process(agentId, sessionId, reason);
        } finally {
          this.queued.delete(key);
        }
      });
    this.tails.set(agentId, next);
    void next.catch(() => undefined);
  }

  private async process(agentId: string, sessionId: string, _reason: string): Promise<MemoryTickerRunResult> {
    const view = this.safeView(sessionId);
    if (!view?.agentId || view.agentId !== agentId || view.archived) {
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
        priority: 0,
      }, "sealed");
    }
    return {
      sessionId,
      agentId,
      status: summary.status === "updated" ? "updated" : summary.status,
      batchId,
      ...(summary.status !== "updated" ? { reason: summary.reason } : {}),
    };
  }

  private async housekeeping(): Promise<void> {
    if (this.stopped) return;
    const now = this.deps.options?.now?.() ?? Date.now();
    const idleMs = this.deps.options?.idleMs ?? 30 * 60 * 1000;
    for (const agent of this.deps.agentStore.list()) {
      const agentId = agent.identity.id;
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
