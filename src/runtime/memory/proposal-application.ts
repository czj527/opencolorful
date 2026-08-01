import type Database from "better-sqlite3";
import type { MemoryMutationProposal } from "../../contracts/memory.js";
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
  watermarkStore: MemoryWatermarkStore; policy: MemoryPolicy; now?: () => Date;
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
        }
        const check = this.deps.policy.check(proposal);
        if (!check.approved) {
          this.deps.proposalStore.markStatus(proposal.id, "rejected", { policyReason: check.reason });
          result.rejected.push({ proposal, reason: check.reason });
          continue;
        }
        // 应用异常不捕获：向上抛出 → 整个事务回滚（不留下已执行 SQL 的半成品）
        const applied = this.applyMutation(proposal);
        // 回写应用生成的 id（newFactId/mergedFactId/createdFactId）到持久化负载，回滚据此定位新建事实
        this.deps.proposalStore.updatePayload(proposal.id, proposal.payload);
        this.deps.proposalStore.markStatus(proposal.id, "applied", { appliedAt: this.now().toISOString() });
        this.deps.journalStore.appendSystemIntent({ id: `proposal:${proposal.id}`, agentId: proposal.agentId, actor: "memory_agent", intentType: journalType(proposal.type), targetType: proposal.targetType === "event" ? "event" : "fact", ...(proposal.targetId ? { targetId: proposal.targetId } : {}), payload: { mutationType: proposal.type, proposalId: proposal.id, ...proposal.payload }, status: "applied", appliedAt: this.now().toISOString() });
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
          const target = proposal.targetId !== undefined ? id(proposal.targetId) : this.findCreatedFact(proposal.agentId, text, proposal.evidenceRefs);
          this.deps.factStore.markSuppressed(target);
        } else if (proposal.type === "strength_change") {
          this.deps.factStore.updateRetention(id(proposal.targetId), Number(previous?.retention ?? previous?.retentionStrength));
        } else if (proposal.type === "forget") {
          this.deps.factStore.restoreFact(id(proposal.targetId));
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
    if (proposal.type === "forget") { if (proposal.targetType === "fact") { this.assertOwnFact(proposal, id(proposal.targetId)); this.deps.factStore.markForgotten(id(proposal.targetId), { reason: proposal.reason }); } else if (proposal.targetType === "event") this.deps.eventStore.updateStatus(proposal.targetId as string, "forgotten"); return proposal; }
    if (proposal.type === "restore") { this.assertOwnFact(proposal, id(proposal.targetId)); this.deps.factStore.restoreFact(id(proposal.targetId)); return proposal; }
    if (proposal.type === "supersede") { this.assertOwnFact(proposal, id(payload.supersededFactId)); const retentionStrength = this.deps.policy.computeInitialRetention(proposal); const newFact = this.deps.factStore.createFact({ agentId: proposal.agentId, fact: String(payload.newFact), tags: [], source: "agent_approved", sourceRefs: proposal.evidenceRefs, confidence: proposal.confidence, retentionStrength }); this.deps.factStore.supersedeFact({ factId: id(payload.supersededFactId), newFactId: newFact.id }); (payload as Record<string, unknown>).newFactId = newFact.id; return proposal; }
    if (proposal.type === "merge") { for (const factId of (payload.factIds as unknown[]).map(id)) this.assertOwnFact(proposal, factId); const retentionStrength = this.deps.policy.computeInitialRetention(proposal); const merged = this.deps.factStore.createFact({ agentId: proposal.agentId, fact: String(payload.mergedFact), tags: [], source: "agent_approved", sourceRefs: proposal.evidenceRefs, confidence: proposal.confidence, retentionStrength }); this.deps.factStore.mergeFacts({ factIds: (payload.factIds as unknown[]).map(id), mergedFactId: merged.id }); (payload as Record<string, unknown>).mergedFactId = merged.id; return proposal; }
    return proposal;
  }
}
