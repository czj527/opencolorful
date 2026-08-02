import type Database from "better-sqlite3";
import type { MemoryMutationProposal } from "../../contracts/memory.js";
import type { ResourceRef } from "../../contracts/observability.js";
import { instrument } from "../../observability/instrument.js";
import { assertDurableAudit, type AuditRecorder } from "../../observability/audit-recorder.js";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryEventStore } from "../../storage/memory/event-store.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import type { MemoryProposalStore } from "../../storage/memory/proposal-store.js";
import type { MemoryPolicy } from "./memory-policy.js";

export interface ApplicationResult {
  applied: MemoryMutationProposal[];
  rejected: Array<{ proposal: MemoryMutationProposal; reason: string }>;
  failed: Array<{ proposal: MemoryMutationProposal; error: Error }>;
}
interface Deps {
  database: Database.Database; proposalStore: MemoryProposalStore; factStore: MemoryFactStore;
  eventStore: MemoryEventStore; journalStore: MemoryJournalStore; batchStore: MemoryBatchStore;
  watermarkStore: MemoryWatermarkStore; policy: MemoryPolicy;
  /**
   * 评审 P0（第三轮）：记忆审批/遗忘/强度变更属 fail-closed 清单——
   * 审计与事实修改同一 SQLite 事务（appendStrict 同库）；
   * 审计未配置或未被接受 → 抛错 → 整体回滚。
   */
  audit?: AuditRecorder;
  now?: () => Date;
}
function id(value: unknown): number { if (typeof value === "number") return value; if (typeof value === "string") return Number(value); throw new Error("事实 ID 无效"); }
function journalType(type: MemoryMutationProposal["type"]): "remember" | "forget" | "supersede" | "merge" | "restore" { const mapped: Record<MemoryMutationProposal["type"], "remember" | "forget" | "supersede" | "merge" | "restore"> = { create_fact: "remember", strength_change: "remember", supersede: "supersede", merge: "merge", forget: "forget", restore: "restore", longterm_projection: "remember" }; return mapped[type]; }

/**
 * 提案应用器。
 *
 * 事务契约（plans/phase-10.5.md §六）：事实、proposal 状态、journal 留痕、
 * markdown dirty watermark、用户 intent 结算在同一 SQLite 事务内提交；
 * 任何应用异常向上抛出 → 整个事务回滚，不留半成品。
 */
export class ProposalApplication {
  private readonly now: () => Date;
  constructor(private readonly deps: Deps) { this.now = deps.now ?? (() => new Date()); }

  applyRun(
    input: { agentId: string; runId: string; proposals: readonly MemoryMutationProposal[] },
    hooks?: { settleIntents?: (agentId: string, applied: readonly MemoryMutationProposal[]) => void },
  ): ApplicationResult {
    const result: ApplicationResult = { applied: [], rejected: [], failed: [] };
    const transaction = this.deps.database.transaction(() => {
      for (const proposal of input.proposals) {
        // 提案必须已持久化（记忆 Agent 只收集内存提案；先落 proposals 表再审批）
        if (this.deps.proposalStore.getById(proposal.id) === undefined) {
          this.deps.proposalStore.createProposal(proposal);
          // Phase 11 T5：提案创建（不含记忆正文，只记 id/类型）
          instrument.activity({
            eventName: "memory.proposal.created",
            actor: { kind: "memory_agent", id: proposal.agentId },
            executor: { kind: "memory_agent", id: proposal.agentId },
            scope: { ownerAgentId: proposal.agentId },
            target: { kind: "memory_fact", id: String(proposal.targetId ?? proposal.id) },
            payload: { summaryCode: "memory_proposal_created", attributes: { type: proposal.type, runId: proposal.runId } },
          });
        }
        const check = this.deps.policy.check(proposal);
        if (!check.approved) {
          this.deps.proposalStore.markStatus(proposal.id, "rejected", { policyReason: check.reason });
          result.rejected.push({ proposal, reason: check.reason });
          // Phase 11 T5：审批证据（auditMirror 同库；版本冲突归 conflicted）
          const conflicted = /版本冲突|未解决冲突/.test(check.reason);
          instrument.activity({
            eventName: conflicted ? "memory.proposal.conflicted" : "memory.proposal.rejected",
            actor: { kind: "memory_agent", id: proposal.agentId },
            executor: { kind: "memory_agent", id: proposal.agentId },
            scope: { ownerAgentId: proposal.agentId },
            target: { kind: "memory_fact", id: String(proposal.targetId ?? proposal.id) },
            payload: {
              summaryCode: conflicted ? "memory_proposal_conflicted" : "memory_proposal_rejected",
              attributes: { type: proposal.type, reason: check.reason.slice(0, 200) },
            },
          });
          continue;
        }
        // 应用异常不捕获：向上抛出 → 整个事务回滚（不留下已执行 SQL 的半成品）
        const applied = this.applyMutation(proposal);
        // 回写应用生成的 id（newFactId/mergedFactId/createdFactId）到持久化负载，回滚据此定位新建事实
        this.deps.proposalStore.updatePayload(proposal.id, proposal.payload);
        this.deps.proposalStore.markStatus(proposal.id, "applied", { appliedAt: this.now().toISOString() });
        this.deps.journalStore.appendSystemIntent({ id: `proposal:${proposal.id}`, agentId: proposal.agentId, actor: "memory_agent", intentType: journalType(proposal.type), targetType: proposal.targetType === "event" ? "event" : "fact", ...(proposal.targetId ? { targetId: proposal.targetId } : {}), payload: { mutationType: proposal.type, proposalId: proposal.id, ...proposal.payload }, status: "applied", appliedAt: this.now().toISOString() });
        // 评审 P0（第三轮）：审批/遗忘/强度变更与事实修改同一事务落严格审计——
        // 审计未配置或未被接受 → 抛错 → 整个事务回滚，事实不会"已改但无审计"
        this.recordStrictAudit(proposal);
        // Phase 11 T5：审批通过与逐类事实证据（auditMirror；只记 id/强度，不记正文）
        this.recordAppliedEvidence(proposal);
        result.applied.push(applied);
      }
      if (result.applied.length > 0) {
        // 事实变更 → 上下文记忆 Markdown 过期（projection revision 与事实同事务提交）
        this.deps.watermarkStore.upsert(input.agentId, "markdown", "", { stale: true }, true);
        hooks?.settleIntents?.(input.agentId, result.applied);
      }
    });
    transaction();
    return result;
  }

  rollbackRun(input: { agentId: string; runId: string }): ApplicationResult {
    const result: ApplicationResult = { applied: [], rejected: [], failed: [] };
    const transaction = this.deps.database.transaction(() => {
      for (const proposal of this.deps.proposalStore.listAppliedByRun(input.runId).filter((item) => item.agentId === input.agentId).reverse()) {
        // 与 applyRun 同一契约：回滚任一步骤失败 → 整个回滚事务回滚，由调用方重试或报错
        const previous = proposal.previousState;
        if (proposal.type === "create_fact" || proposal.type === "longterm_projection") {
          const text = String(proposal.payload.fact ?? proposal.payload.content);
          // 优先使用 applyRun 回写并持久化的 createdFactId（确定性定位），
          // 回退旧路径（findCreatedFact 受 listByAgent 默认 50 条限制，事实多时会误报找不到）
          const createdId = typeof proposal.payload.createdFactId === "number" ? proposal.payload.createdFactId : undefined;
          const created = createdId !== undefined ? this.deps.factStore.getById(createdId) : undefined;
          const target = created !== undefined && created.agentId === proposal.agentId
            ? created.id
            : (proposal.targetId !== undefined ? id(proposal.targetId) : this.findCreatedFact(proposal.agentId, text, proposal.evidenceRefs));
          this.deps.factStore.markSuppressed(target);
        } else if (proposal.type === "strength_change") {
          this.deps.factStore.updateRetention(id(proposal.targetId), Number(previous?.retention ?? previous?.retentionStrength));
        } else if (proposal.type === "forget") {
          if (proposal.targetType === "event") {
            // 事件遗忘回滚：恢复事件为 active（原实现误把事件 id 当数字事实 id → 事实不存在: NaN）
            const targetEvent = this.deps.eventStore.getById(proposal.targetId as string);
            if (targetEvent !== undefined && targetEvent.status === "forgotten") {
              this.deps.eventStore.updateStatus(targetEvent.id, "active");
            }
          } else {
            this.deps.factStore.restoreFact(id(proposal.targetId));
          }
        } else if (proposal.type === "supersede") {
          this.deps.factStore.restoreFact(id(proposal.payload.supersededFactId));
          if (proposal.payload.newFactId !== undefined) this.deps.factStore.markSuppressed(id(proposal.payload.newFactId));
        } else if (proposal.type === "merge") {
          for (const factId of (proposal.payload.factIds as unknown[] ?? []).map(id)) this.deps.factStore.restoreFact(factId);
          if (proposal.payload.mergedFactId !== undefined) this.deps.factStore.markSuppressed(id(proposal.payload.mergedFactId));
        }
        this.deps.proposalStore.markStatus(proposal.id, "reverted");
        // 回滚留痕（actor=system），与「反向 mutation journal」契约一致
        this.deps.journalStore.appendSystemIntent({
          id: `rollback:${proposal.id}`,
          agentId: proposal.agentId,
          actor: "system",
          intentType: "restore",
          targetType: proposal.targetType === "event" ? "event" : "fact",
          ...(proposal.targetId ? { targetId: proposal.targetId } : {}),
          payload: { mutationType: proposal.type, proposalId: proposal.id, rollback: true },
          status: "applied",
          appliedAt: this.now().toISOString(),
        });
        result.applied.push(proposal);
      }
    });
    transaction();
    return result;
  }

  private findCreatedFact(agentId: string, text: string, sourceRefs: readonly string[]): number {
    const match = this.deps.factStore.listByAgent(agentId).find((fact) => fact.fact === text && sourceRefs.every((ref) => fact.sourceRefs.includes(ref)));
    if (!match) throw new Error("找不到待回滚的创建事实");
    return match.id;
  }

  /** 防御纵深：应用前再次确认目标事实归属当前 Agent（policy 已校验，此处双保险） */
  private assertOwnFact(proposal: MemoryMutationProposal, factId: number): void {
    const fact = this.deps.factStore.getById(factId);
    if (fact !== undefined && fact.agentId !== proposal.agentId) throw new Error("目标事实不属于当前 Agent");
  }

  /**
   * 评审 P0（第三轮）：严格审计（fail-closed）。与事实修改同一 SQLite 事务——
   * appendStrict 同库写入，任何失败（含审计未配置）抛错 → 整体回滚。
   * 只记 id/类型/强度，绝不记录事实正文。
   */
  private recordStrictAudit(proposal: MemoryMutationProposal): void {
    if (this.deps.audit === undefined) {
      throw new Error("可观测性未初始化，记忆审批拒绝执行");
    }
    const scope = { ownerAgentId: proposal.agentId };
    const factTarget = (id: string | number | undefined): ResourceRef | undefined =>
      id === undefined ? undefined : { kind: "memory_fact" as const, id: String(id) };
    const target = factTarget(proposal.targetId);
    const actor = { kind: "memory_agent" as const, id: proposal.agentId };
    // 审批通过本身（每个 applied 提案）
    assertDurableAudit(this.deps.audit.appendStrict({
      eventName: "audit.memory.proposal_approved",
      payload: { action: "memory.proposal.approved", decision: "allowed", changedFields: ["memory"] },
      actor,
      executor: actor,
      scope,
      ...(target !== undefined ? { target } : {}),
    }), "记忆审批");
    // 逐类变更证据（目录固定的 audit 事件）
    if (proposal.type === "strength_change") {
      assertDurableAudit(this.deps.audit.appendStrict({
        eventName: "audit.memory.strength_changed",
        payload: {
          action: "memory.strength.changed", decision: "allowed",
          changedFields: ["retentionStrength"],
        },
        actor,
        executor: actor,
        scope,
        target: factTarget(proposal.targetId) ?? { kind: "memory_fact", id: "unknown" },
      }), "记忆强度变更");
    } else if (proposal.type === "forget" && proposal.targetType === "fact") {
      assertDurableAudit(this.deps.audit.appendStrict({
        eventName: "audit.memory.fact_forgotten",
        payload: { action: "memory.fact.forgotten", decision: "allowed", changedFields: ["status"] },
        actor,
        executor: actor,
        scope,
        target: factTarget(proposal.targetId) ?? { kind: "memory_fact", id: "unknown" },
      }), "记忆遗忘");
    } else if (proposal.type === "supersede") {
      const supersededId = proposal.payload.supersededFactId as string | number | undefined;
      assertDurableAudit(this.deps.audit.appendStrict({
        eventName: "audit.memory.fact_superseded",
        payload: { action: "memory.fact.superseded", decision: "allowed", changedFields: ["status", "valid_until"] },
        actor,
        executor: actor,
        scope,
        target: factTarget(supersededId) ?? { kind: "memory_fact", id: "unknown" },
      }), "记忆取代");
    }
  }

  /**
   * Phase 11 T5：审批通过证据 + 逐类事实变更（auditMirror 同库）。
   * 只记 id/强度数字，绝不记录事实正文。
   */
  private recordAppliedEvidence(proposal: MemoryMutationProposal): void {
    const scope = { ownerAgentId: proposal.agentId };
    const factTarget = (id: string | number | undefined): ResourceRef | undefined =>
      id === undefined ? undefined : { kind: "memory_fact" as const, id: String(id) };
    const approvedTarget = factTarget(proposal.targetId);
    instrument.activity({
      eventName: "memory.proposal.approved",
      actor: { kind: "memory_agent", id: proposal.agentId },
      executor: { kind: "memory_agent", id: proposal.agentId },
      scope,
      ...(approvedTarget !== undefined ? { target: approvedTarget } : {}),
      payload: { summaryCode: "memory_proposal_approved", attributes: { type: proposal.type, runId: proposal.runId } },
    });
    if (proposal.type === "strength_change") {
      instrument.activity({
        eventName: "memory.strength.changed",
        actor: { kind: "memory_agent", id: proposal.agentId },
        executor: { kind: "memory_agent", id: proposal.agentId },
        scope,
        target: factTarget(proposal.targetId) ?? { kind: "memory_fact", id: "unknown" },
        payload: {
          summaryCode: "memory_strength_changed",
          attributes: {
            factId: String(proposal.targetId ?? ""),
            from: Number(proposal.previousState?.retention ?? proposal.previousState?.retentionStrength ?? 0),
            to: Number(proposal.payload.retentionStrength ?? 0),
          },
        },
      });
    } else if (proposal.type === "forget") {
      instrument.activity({
        eventName: "memory.fact.forgotten",
        actor: { kind: "memory_agent", id: proposal.agentId },
        executor: { kind: "memory_agent", id: proposal.agentId },
        scope,
        target: factTarget(proposal.targetId) ?? { kind: "memory_fact", id: "unknown" },
        payload: { summaryCode: "memory_fact_forgotten", attributes: { factId: String(proposal.targetId ?? "") } },
      });
    } else if (proposal.type === "supersede") {
      const supersededId = proposal.payload.supersededFactId as string | number | undefined;
      const newFactId = proposal.payload.newFactId as string | number | undefined;
      instrument.activity({
        eventName: "memory.fact.superseded",
        actor: { kind: "memory_agent", id: proposal.agentId },
        executor: { kind: "memory_agent", id: proposal.agentId },
        scope,
        target: factTarget(supersededId) ?? { kind: "memory_fact", id: "unknown" },
        payload: {
          summaryCode: "memory_fact_superseded",
          attributes: {
            factId: String(supersededId ?? ""),
            newFactId: String(newFactId ?? ""),
          },
        },
      });
    }
  }

  private applyMutation(proposal: MemoryMutationProposal): MemoryMutationProposal {
    const payload = proposal.payload;
    if (proposal.type === "create_fact" || proposal.type === "longterm_projection") {
      const text = String(payload.fact ?? payload.content);
      // 新事实初始强度：显式给出则钳制 0-100；缺省按证据/可信度/用户意图确定性计算（不再默认 0）
      const retentionStrength = this.deps.policy.computeInitialRetention(proposal);
      const fact = this.deps.factStore.createFact({ agentId: proposal.agentId, fact: text, tags: [...(Array.isArray(payload.tags) ? payload.tags.filter((v): v is string => typeof v === "string") : []), ...(proposal.type === "longterm_projection" ? ["projection"] : [])], ...(typeof payload.factTime === "string" ? { factTime: payload.factTime } : {}), ...(typeof payload.validUntil === "string" ? { validUntil: payload.validUntil } : {}), source: "agent_approved", sourceRefs: proposal.evidenceRefs, confidence: proposal.confidence, retentionStrength });
      (payload as Record<string, unknown>).createdFactId = fact.id; return proposal;
    }
    if (proposal.type === "strength_change") { this.assertOwnFact(proposal, id(proposal.targetId)); this.deps.factStore.updateRetention(id(proposal.targetId), Number(payload.retentionStrength)); return proposal; }
    if (proposal.type === "forget") { if (proposal.targetType === "fact") { this.assertOwnFact(proposal, id(proposal.targetId)); this.deps.factStore.markForgotten(id(proposal.targetId), { reason: proposal.reason }); } else if (proposal.targetType === "event") { const evt = this.deps.eventStore.getById(proposal.targetId as string); if (evt !== undefined && evt.agentId !== proposal.agentId) throw new Error("目标事件不属于当前 Agent"); this.deps.eventStore.updateStatus(proposal.targetId as string, "forgotten"); } return proposal; }
    if (proposal.type === "restore") { this.assertOwnFact(proposal, id(proposal.targetId)); this.deps.factStore.restoreFact(id(proposal.targetId)); return proposal; }
    if (proposal.type === "supersede") { this.assertOwnFact(proposal, id(payload.supersededFactId)); const retentionStrength = this.deps.policy.computeInitialRetention(proposal); const newFact = this.deps.factStore.createFact({ agentId: proposal.agentId, fact: String(payload.newFact), tags: [], source: "agent_approved", sourceRefs: proposal.evidenceRefs, confidence: proposal.confidence, retentionStrength }); this.deps.factStore.supersedeFact({ factId: id(payload.supersededFactId), newFactId: newFact.id }); (payload as Record<string, unknown>).newFactId = newFact.id; return proposal; }
    if (proposal.type === "merge") { for (const factId of (payload.factIds as unknown[]).map(id)) this.assertOwnFact(proposal, factId); const retentionStrength = this.deps.policy.computeInitialRetention(proposal); const merged = this.deps.factStore.createFact({ agentId: proposal.agentId, fact: String(payload.mergedFact), tags: [], source: "agent_approved", sourceRefs: proposal.evidenceRefs, confidence: proposal.confidence, retentionStrength }); this.deps.factStore.mergeFacts({ factIds: (payload.factIds as unknown[]).map(id), mergedFactId: merged.id }); (payload as Record<string, unknown>).mergedFactId = merged.id; return proposal; }
    return proposal;
  }
}
