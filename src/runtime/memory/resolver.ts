// ═══════════════════════════════════════════════════════════════
// MemoryAgentResolver（plans/phase-10.5.md §三/§七）
//
// 编排一次完整的整理运行：
//   pending batches + journal intents → MemoryAgentRunner（只提案）
//   → ProposalApplication（MemoryPolicy 单事务应用/拒绝/失败）
//   → batch/journal 状态推进 + watermark dirty + memory.agent.* SSE
//
// 半成品（未提交 proposal）对主 Agent 不可见；失败保留批次与原因，
// 由 scheduler 按 nextRetryAt 重试。
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import path from "node:path";

import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type {
  MemoryAgentSettings,
  MemoryAgentPayload,
  MemoryRunStatus,
} from "../../contracts/memory.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryEventStore } from "../../storage/memory/event-store.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { MemoryProposalStore } from "../../storage/memory/proposal-store.js";
import type { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import type { MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import type { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import { ProposalApplication } from "./proposal-application.js";
import { MemoryAgentRunner } from "./agent/memory-agent-runner.js";
import { nextAgentStreamSequence } from "./recall-service.js";
import type { ActivationUpdater } from "./activation-updater.js";

export interface MemoryAgentResolverDeps {
  readonly batchStore: MemoryBatchStore;
  readonly journalStore: MemoryJournalStore;
  readonly factStore: MemoryFactStore;
  readonly eventStore: MemoryEventStore;
  readonly recallStore: MemoryRecallStore;
  readonly proposalStore: MemoryProposalStore;
  readonly watermarkStore: MemoryWatermarkStore;
  readonly summaryStore: SessionSummaryStore;
  readonly application: ProposalApplication;
  readonly settingsResolver: (agentId: string) => MemoryAgentSettings;
  readonly completeText: (req: { systemPrompt: string; prompt: string; maxTokens?: number }) => Promise<string>;
  readonly sessionPathResolver: (sessionId: string) => string;
  readonly agentsDir: string;
  readonly publish: (envelope: PlatformEventEnvelope) => void;
  readonly activationUpdater?: Pick<ActivationUpdater, "updateForHits">;
  readonly assertSessionReadable?: (sessionPath: string) => void;
  readonly limits?: { maxIterations?: number; maxTokens?: number; maxMinutes?: number };
  readonly now?: () => Date;
}

export interface MaintenanceOutcome {
  readonly runId: string;
  readonly agentId: string;
  readonly status: MemoryRunStatus;
  readonly applied: number;
  readonly rejected: number;
  readonly batchIds: readonly string[];
  readonly reason?: string;
}

function agentEnvelope(
  agentId: string,
  sessionId: string | null,
  type: PlatformEventEnvelope["type"],
  payload: MemoryAgentPayload,
  publish: (envelope: PlatformEventEnvelope) => void,
): void {
  publish({
    protocolVersion: 1,
    eventId: crypto.randomUUID(),
    sessionId,
    streamId: `agent:${agentId}`,
    sequence: nextAgentStreamSequence(`agent:${agentId}`),
    timestamp: new Date().toISOString(),
    type,
    payload,
  });
}

export class MemoryAgentResolver {
  private readonly now: () => Date;

  constructor(private readonly deps: MemoryAgentResolverDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 运行一次整理（每日窗口/每周复核/手动 deep-dive 共用）。
   * weekly=true 时附带低置信度/跨日期聚合的额外复核提示。
   */
  async runMaintenance(agentId: string, opts: { weekly?: boolean } = {}): Promise<MaintenanceOutcome> {
    const runId = `run_${crypto.randomUUID()}`;
    const startedAt = this.now().toISOString();
    const emit = (status: MemoryRunStatus, phase?: string, reason?: string) => {
      agentEnvelope(agentId, null, `memory.agent.${status}` as PlatformEventEnvelope["type"], {
        runId,
        agentId,
        status,
        ...(phase !== undefined ? { phase } : {}),
        ...(reason !== undefined ? { reason } : {}),
      }, this.deps.publish);
    };

    emit("started", "提取候选");
    try {
      const runner = new MemoryAgentRunner({
        agentId,
        batchStore: this.deps.batchStore,
        journalStore: this.deps.journalStore,
        factStore: this.deps.factStore,
        eventStore: this.deps.eventStore,
        agentsDir: this.deps.agentsDir,
        completeText: this.deps.completeText,
        sessionPathResolver: this.deps.sessionPathResolver,
        runId,
        ...(this.deps.assertSessionReadable !== undefined
          ? { assertSessionReadable: this.deps.assertSessionReadable }
          : {}),
        ...(this.deps.limits ? { limits: this.deps.limits } : {}),
        now: this.now,
      });
      emit("processing", "记忆 Agent 整理");
      const run = await runner.run();
      const batchIds = run.batchIds;

      if (run.status === "deferred" || run.status === "failed") {
        // 失败保留 sealed batch 与原因（计划 §六）；仅超预算标记 deferred 供重试
        if (run.status === "deferred") {
          for (const batchId of batchIds) {
            try { this.deps.batchStore.markStatus(batchId, "deferred"); } catch { /* 批次可能已被消费 */ }
          }
        }
        emit(run.status, undefined, run.reason ?? "预算或模型不可用");
        return {
          runId, agentId, status: run.status, applied: 0, rejected: 0, batchIds,
          ...(run.reason !== undefined ? { reason: run.reason } : {}),
        };
      }

      emit("processing", "策略审批");
      const outcome = this.deps.application.applyRun({ agentId, runId: run.runId, proposals: run.proposals });

      // 应用成功后推进批次/意图/水印状态
      if (outcome.applied.length > 0) {
        for (const batchId of batchIds) {
          try { this.deps.batchStore.markStatus(batchId, "applied"); } catch { /* ignore */ }
        }
        // 事实变更 → facts.md/memory.md 过期，标记 markdown dirty 等待跨日重编译
        this.deps.watermarkStore.upsert(agentId, "markdown", "", { stale: true }, true);
        // activation 投影重算（本轮新增/调整的事实）
        const factIds = outcome.applied
          .filter((p) => p.type === "create_fact" || p.type === "strength_change")
          .map((p) => p.targetId ?? p.payload.createdFactId)
          .filter((v): v is string | number => v !== undefined)
          .map(String);
        if (factIds.length > 0) {
          this.deps.activationUpdater?.updateForHits({ agentId, targetIds: factIds });
        }
        // 匹配的用户意图标记 applied（remember↔create_fact 文本一致；forget↔forget 目标一致）
        this.settleJournalIntents(agentId, outcome);
        emit("completed", "整理完成");
      } else if (outcome.rejected.length > 0) {
        // 全被拒绝：批次保持 pending，不标记失败（策略拒绝是正常结果）
        emit("completed", "策略拒绝，批次保留");
      } else {
        emit("completed", "无可用提案");
      }

      return {
        runId,
        agentId,
        status: "completed",
        applied: outcome.applied.length,
        rejected: outcome.rejected.length,
        batchIds,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emit("failed", undefined, reason);
      return { runId, agentId, status: "failed", applied: 0, rejected: 0, batchIds: [], reason };
    }
  }

  /** remember/forget 用户意图与已应用提案对齐后标记 applied */
  private settleJournalIntents(agentId: string, outcome: { applied: readonly import("../../contracts/memory.js").MemoryMutationProposal[] }): void {
    for (const proposal of outcome.applied) {
      if (proposal.type === "create_fact" || proposal.type === "longterm_projection") {
        const text = String(proposal.payload.fact ?? proposal.payload.content ?? "");
        for (const intent of this.deps.journalStore.listPending(agentId)) {
          if (
            intent.intentType === "remember" &&
            typeof intent.payload["fact"] === "string" &&
            intent.payload["fact"] === text &&
            intent.status === "pending"
          ) {
            this.deps.journalStore.markStatus(intent.id, "applied");
          }
        }
      }
      if (proposal.type === "forget" && proposal.targetId !== undefined) {
        for (const intent of this.deps.journalStore.listPending(agentId)) {
          if (
            intent.intentType === "forget" &&
            intent.targetId === proposal.targetId &&
            intent.status === "pending"
          ) {
            this.deps.journalStore.markStatus(intent.id, "applied");
          }
        }
      }
    }
  }

  /** 供 T6 手动 deep-dive 触发的入口 */
  async deepDive(agentId: string, opts: { weekly?: boolean } = {}): Promise<MaintenanceOutcome> {
    return this.runMaintenance(agentId, opts);
  }

  /** 暴露审批应用器（T6 rollback 端点使用） */
  get application(): ProposalApplication {
    return this.deps.application;
  }
}
