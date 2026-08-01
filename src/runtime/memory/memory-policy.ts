import type {
  MemoryAgentSettings,
  MemoryFact,
  MemoryMutationProposal,
  MemoryPolicyResult,
} from "../../contracts/memory.js";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { MemoryRecallStore } from "../../storage/memory/recall-store.js";

interface PolicyDeps {
  factStore: MemoryFactStore;
  recallStore: MemoryRecallStore;
  journalStore: MemoryJournalStore;
  settingsResolver: (agentId: string) => MemoryAgentSettings;
  now?: () => Date;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function idValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
function tier(strength: number, settings: MemoryAgentSettings): "short" | "medium" | "permanent" {
  if (strength >= settings.retentionThresholds.permanentUp) return "permanent";
  if (strength >= settings.retentionThresholds.mediumUp) return "medium";
  return "short";
}

export class MemoryPolicy {
  private readonly now: () => Date;
  constructor(private readonly deps: PolicyDeps) { this.now = deps.now ?? (() => new Date()); }

  check(proposal: MemoryMutationProposal): MemoryPolicyResult {
    if (!proposal.runId.trim()) return { approved: false, reason: "提案缺少 runId" };
    if (proposal.evidenceRefs.length === 0) return { approved: false, reason: "提案缺少证据引用" };
    const settings = this.deps.settingsResolver(proposal.agentId);
    const factId = idValue(proposal.targetId);
    const current = factId === undefined ? undefined : this.deps.factStore.getById(factId);
    const previous = proposal.previousState;

    if (proposal.type === "create_fact" || proposal.type === "longterm_projection") {
      if (!proposal.reason.trim() && proposal.evidenceRefs.length === 0) return { approved: false, reason: "创建事实必须提供理由或证据" };
      const text = typeof proposal.payload.fact === "string" ? proposal.payload.fact : proposal.payload.content;
      if (typeof text !== "string" || !text.trim()) return { approved: false, reason: "创建事实缺少内容" };
      const normalized = text.normalize("NFKC").trim().toLowerCase();
      const duplicate = this.deps.factStore.listByAgent(proposal.agentId).some((fact) => {
        const other = fact.fact.normalize("NFKC").trim().toLowerCase();
        return other === normalized || other.includes(normalized) || normalized.includes(other);
      });
      if (duplicate) return { approved: false, reason: "存在语义重复事实，建议先合并" };
      return { approved: true, reason: "策略检查通过" };
    }

    if (proposal.type === "strength_change") {
      if (!current || current.status !== "active") return { approved: false, reason: "目标事实不存在或已非 active" };
      const proposed = numberValue(proposal.payload.retentionStrength);
      const old = numberValue(previous?.retention) ?? numberValue(previous?.retentionStrength);
      if (proposed === undefined || old === undefined || old !== current.retentionStrength) return { approved: false, reason: "事实版本冲突，请重新计算提案" };
      if (tier(current.retentionStrength, settings) === "permanent" && proposed < current.retentionStrength) return { approved: false, reason: "永久记忆不可衰减" };
      const currentTier = tier(current.retentionStrength, settings);
      const proposedTier = tier(proposed, settings);
      const ranks = { short: 0, medium: 1, permanent: 2 };
      if (ranks[proposedTier] - ranks[currentTier] > 1) return { approved: false, reason: "跨档跳跃受限，请先逐档提升" };
      if (currentTier === "medium" && proposedTier === "permanent") {
        const refs = new Set(proposal.evidenceRefs);
        // evidenceRefs 形如 "session:<sessionId>"；独立会话 = 冒号后的 session id 去重
        const sessions = new Set([...refs].map((ref) => ref.split(":")[1] ?? ref));
        const dates = new Set(this.deps.recallStore.listByAgent(proposal.agentId)
          .filter((entry) => entry.targetId === String(current.id)).map((entry) => entry.createdAt.slice(0, 10)));
        if (sessions.size < 2) return { approved: false, reason: "晋升永久需要至少两个独立会话证据" };
        if (dates.size < 2) return { approved: false, reason: "晋升永久需要至少两个独立日期证据" };
        if (proposal.confidence < 0.8) return { approved: false, reason: "晋升永久需要至少 0.8 可信度" };
        const conflict = this.deps.journalStore.listPending(proposal.agentId).some((intent) =>
          intent.targetId === String(current.id) && ["supersede", "merge", "suppress", "forget"].includes(intent.intentType));
        if (conflict) return { approved: false, reason: "目标事实存在未解决冲突" };
      }
      return this.checkWatermark(proposal, current.id);
    }

    if (["supersede", "merge"].includes(proposal.type)) {
      const ids: number[] = proposal.type === "merge"
        ? ((proposal.payload.factIds as unknown[] | undefined)?.map(idValue).filter((item): item is number => item !== undefined) ?? [])
        : (factId === undefined ? [] : [factId]);
      if (!ids?.length || ids.some((id) => !this.deps.factStore.getActiveById(id))) return { approved: false, reason: "目标事实版本冲突或已非 active" };
      const firstId = ids[0];
      if (firstId === undefined) return { approved: false, reason: "目标事实不存在" };
      return this.checkWatermark(proposal, firstId);
    }
    if (proposal.type === "forget") {
      if (!proposal.reason.trim()) return { approved: false, reason: "遗忘必须提供理由" };
      if (proposal.targetType === "fact" && (!current || current.status === "suppressed")) return { approved: false, reason: "目标事实不存在" };
      return this.checkWatermark(proposal, factId);
    }
    if (proposal.type === "restore") {
      if (!current || current.status !== "forgotten") return { approved: false, reason: "只有 forgotten 事实允许恢复" };
      return this.checkWatermark(proposal, current.id);
    }
    return { approved: false, reason: "不支持的提案类型" };
  }

  private checkWatermark(proposal: MemoryMutationProposal, targetId: number | undefined): MemoryPolicyResult {
    const watermark = typeof proposal.payload.journalWatermark === "string" ? proposal.payload.journalWatermark : undefined;
    if (!watermark || targetId === undefined) return { approved: true, reason: "策略检查通过" };
    const newer = this.deps.journalStore.listByAgent(proposal.agentId).some((intent) =>
      intent.actor === "user" && intent.targetId === String(targetId) && intent.createdAt > watermark);
    return newer ? { approved: false, reason: "journal 水位线之后出现用户意图，请重新计算提案" } : { approved: true, reason: "策略检查通过" };
  }
}
