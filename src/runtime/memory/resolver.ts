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
import { instrument } from "../../observability/instrument.js";
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
  readonly completeText: (agentId: string, req: { systemPrompt: string; prompt: string; maxTokens?: number }) => Promise<string>;
  readonly sessionPathResolver: (sessionId: string) => string;
  readonly agentsDir: string;
  readonly publish: (envelope: PlatformEventEnvelope) => void;
  readonly activationUpdater?: Pick<ActivationUpdater, "updateForHits">;
  readonly assertSessionReadable?: (sessionPath: string, agentId: string) => void;
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
  payload: MemoryAgentPayload | import("../../contracts/memory.js").MemoryStrengthChangedPayload,
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
   *
   * Phase 11 T5：后台新根 trace（不继承调度触发方的 ALS），
   * 全部 proposal/strength/batch Activity 事件同 trace。
   */
  async runMaintenance(agentId: string, opts: { weekly?: boolean } = {}): Promise<MaintenanceOutcome> {
    return instrument.runAsBackground({ operationId: `mem-agent-${agentId}-${this.now().getTime()}` }, async () => {
      const runId = `run_${crypto.randomUUID()}`;
      const startedAt = this.now().toISOString();
      const lifecycle = instrument.startLifecycle({
        startEventName: "memory.agent.started",
        actor: { kind: "scheduler", id: "memory-scheduler" },
        executor: { kind: "memory_agent", id: agentId },
        scope: { ownerAgentId: agentId },
        operationId: runId,
        terminals: {
          completed: "memory.agent.completed",
          deferred: "memory.agent.deferred",
          failed: "memory.agent.failed",
          interrupted: "memory.agent.interrupted",
        },
        startPayload: { attributes: { weekly: opts.weekly === true } },
      });
      const outcome = await this.runMaintenanceInner(agentId, opts, runId, startedAt);
      if (outcome.status === "deferred") {
        lifecycle.deferred(outcome.reason ?? "预算或模型不可用");
      } else if (outcome.status === "failed") {
        lifecycle.fail(outcome.reason ?? "整理失败");
      } else {
        lifecycle.complete({
          attributes: { applied: outcome.applied, rejected: outcome.rejected },
        });
      }
      return outcome;
    });
  }

  private async runMaintenanceInner(
    agentId: string,
    opts: { weekly?: boolean },
    runId: string,
    startedAt: string,
  ): Promise<MaintenanceOutcome> {
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
      // deepDiveMode 接线（评审 P0-2）：script = 零 LLM 确定性整理（不把记忆意图交给模型）；
      // experimental-agent = LLM 记忆 Agent（只提案，仍经 MemoryPolicy 审批）
      const settings = this.deps.settingsResolver(agentId);
      if (settings.deepDiveMode !== "experimental-agent") {
        emit("processing", "确定性整理（script 模式）");
        // 确定性 housekeeping：activation 投影重建（回忆账本 → activation_strength）
        const allFacts = this.deps.factStore.listByAgent(agentId, { limit: 1_000_000 });
        if (allFacts.length > 0) {
          this.deps.activationUpdater?.updateForHits({ agentId, targetIds: allFacts.map((f) => String(f.id)) });
        }
        // 不触碰 sealed batch（等待用户显式开启 experimental-agent 后处理）
        const completedAt = this.now().toISOString();
        const { writeMemoryRunReport } = await import("./agent/run-report.js");
        await writeMemoryRunReport({
          runId, agentId, agentsDir: this.deps.agentsDir, batchIds: [],
          proposals: [], iterations: 0, status: "completed",
          reason: "script 模式确定性整理（未运行 LLM 代理）",
          startedAt, completedAt, tokenEstimate: 0, issues: [],
          inputSnapshot: { batches: [], pendingIntents: 0 },
        });
        emit("completed", "script 模式：确定性整理完成（未运行 LLM 代理）");
        return { runId, agentId, status: "completed", applied: 0, rejected: 0, batchIds: [] };
      }
      const runner = new MemoryAgentRunner({
        agentId,
        batchStore: this.deps.batchStore,
        journalStore: this.deps.journalStore,
        factStore: this.deps.factStore,
        eventStore: this.deps.eventStore,
        recallStore: this.deps.recallStore,
        agentsDir: this.deps.agentsDir,
        completeText: (req) => this.deps.completeText(agentId, req),
        sessionPathResolver: this.deps.sessionPathResolver,
        runId,
        ...(opts.weekly === true ? { weekly: true } : {}),
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
      // 事实/journal/watermark/意图结算同事务提交；应用异常整体回滚
      const outcome = this.deps.application.applyRun(
        { agentId, runId: run.runId, proposals: run.proposals },
        { settleIntents: (targetAgentId, applied) => this.settleJournalIntents(targetAgentId, applied) },
      );

      if (outcome.failed.length > 0) {
        // 应用阶段失败（策略层已拒绝的走 rejected；此处为事务外异常兜底）→ 批次保留待重试
        const reason = outcome.failed[0]?.error.message ?? "应用阶段失败";
        emit("failed", undefined, reason);
        return { runId, agentId, status: "failed", applied: 0, rejected: outcome.rejected.length, batchIds, reason };
      }

      // 批次结算语义（计划 §六 + 复审 P1）：
      // - processed_noop（completed 且无 rejected 提案）→ 本轮批次结算 applied，避免永久 pending 重复消耗模型；
      // - rejected_retryable（存在被策略拒绝的提案：版本冲突/watermark/证据不足等）→ 批次保留 sealed，
      //   模型可据拒绝原因重新计算，下次运行重试；
      // - 失败/超预算（deferred/failed）→ 批次保留（上方已处理）。
      if (outcome.rejected.length === 0) {
        for (const batchId of batchIds) {
          try { this.deps.batchStore.markStatus(batchId, "applied"); } catch { /* ignore */ }
        }
      }

      if (outcome.applied.length > 0) {
        // activation 投影重算（本轮新增/调整的事实）
        const factIds = outcome.applied
          .filter((p) => p.type === "create_fact" || p.type === "strength_change" || p.type === "supersede" || p.type === "merge")
          .map((p) => p.targetId ?? p.payload.createdFactId)
          .filter((v): v is string | number => v !== undefined)
          .map(String);
        if (factIds.length > 0) {
          this.deps.activationUpdater?.updateForHits({ agentId, targetIds: factIds });
        }
        this.publishStrengthChanged(agentId, outcome.applied);
        emit("completed", "整理完成");
      } else if (outcome.rejected.length > 0) {
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

  /** 已应用的事实强度变更发布 memory.strength.changed（契约已在列，补上生产发布方） */
  private publishStrengthChanged(agentId: string, applied: readonly import("../../contracts/memory.js").MemoryMutationProposal[]): void {
    for (const proposal of applied) {
      const factId = proposal.type === "strength_change" ? proposal.targetId : proposal.payload.createdFactId;
      if (factId === undefined) continue;
      const fact = this.deps.factStore.getById(Number(factId));
      if (fact === undefined) continue;
      agentEnvelope(agentId, null, "memory.strength.changed", {
        agentId,
        factId: Number(factId),
        retentionStrength: fact.retentionStrength,
        activationStrength: fact.activationStrength,
        ...(proposal.type === "strength_change" ? { previousRetention: Number((proposal.previousState as Record<string, unknown> | undefined)?.["retention"] ?? (proposal.previousState as Record<string, unknown> | undefined)?.["retentionStrength"] ?? 0) } : {}),
      }, this.deps.publish);
    }
  }

  /** remember/forget 用户意图与已应用提案对齐后标记 applied */
  private settleJournalIntents(agentId: string, applied: readonly import("../../contracts/memory.js").MemoryMutationProposal[]): void {
    for (const proposal of applied) {
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
