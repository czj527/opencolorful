import type {
  MemoryAgentSettings,
  MemoryFact,
  MemoryMutationProposal,
  MemoryPolicyResult,
} from "../../contracts/memory.js";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import type { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import type { MemoryEventStore } from "../../storage/memory/event-store.js";
import { computeRetention } from "./intensity-calculator.js";

interface PolicyDeps {
  factStore: MemoryFactStore;
  recallStore: MemoryRecallStore;
  journalStore: MemoryJournalStore;
  batchStore: MemoryBatchStore;
  eventStore: MemoryEventStore;
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

/** 证据引用必须形如 "session:<id>" / "event:<id>" / "batch:<id>"，且归属当前 Agent */
function validateEvidenceRefs(refs: readonly string[]): string {
  for (const ref of refs) {
    if (!/^(session|event|batch):[A-Za-z0-9_-]+$/.test(ref)) return `证据引用格式不合法: ${ref.slice(0, 60)}`;
  }
  return "";
}

export class MemoryPolicy {
  private readonly now: () => Date;
  constructor(private readonly deps: PolicyDeps) { this.now = deps.now ?? (() => new Date()); }

  check(proposal: MemoryMutationProposal): MemoryPolicyResult {
    if (!proposal.runId.trim()) return { approved: false, reason: "提案缺少 runId" };
    if (proposal.evidenceRefs.length === 0) return { approved: false, reason: "提案缺少证据引用" };
    const formatIssue = validateEvidenceRefs(proposal.evidenceRefs);
    if (formatIssue) return { approved: false, reason: formatIssue };
    const ownershipIssue = this.checkEvidenceOwnership(proposal);
    if (ownershipIssue) return { approved: false, reason: ownershipIssue };
    const settings = this.deps.settingsResolver(proposal.agentId);
    const factId = idValue(proposal.targetId);
    const current = factId === undefined ? undefined : this.deps.factStore.getById(factId);
    // 跨 Agent 隔离：目标事实必须属于当前 Agent（getById 是全局查询）
    if (current !== undefined && current.agentId !== proposal.agentId) return { approved: false, reason: "目标事实不属于当前 Agent" };
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
      // 迟滞接线：中期降短期必须低于 mediumDown，否则保持在中期档（computeRetention 同一规则）
      if (currentTier === "medium" && proposedTier === "short" && proposed >= settings.retentionThresholds.mediumDown) {
        return { approved: false, reason: `迟滞区间内不允许降档（须低于 ${settings.retentionThresholds.mediumDown}）` };
      }
      if (currentTier === "medium" && proposedTier === "permanent") {
        // 会话/日期以回忆账本为准（确定性，不可由模型伪造引用字符串；全量账本不受 100 条默认限制）
        const ledgerHits = this.deps.recallStore.listByAgent(proposal.agentId, { limit: 1_000_000 })
          .filter((entry) => entry.targetType === "fact" && entry.targetId === String(current.id));
        const sessions = new Set(ledgerHits.map((entry) => entry.sessionId));
        const dates = new Set(ledgerHits.map((entry) => entry.createdAt.slice(0, 10)));
        if (sessions.size < 2) return { approved: false, reason: "晋升永久需要至少两个独立会话的回忆证据" };
        if (dates.size < 2) return { approved: false, reason: "晋升永久需要至少两个独立日期" };
        if (proposal.confidence < 0.8) return { approved: false, reason: "晋升永久需要至少 0.8 可信度" };
        // 晋升证据必须来自已封存/已应用的批次：provisional micro-seal 内容未定稿，
        // 引用它的提案不得把事实抬到永久档（评审 P1#6）
        if (proposal.evidenceRefs.some((ref) => {
          if (!ref.startsWith("batch:")) return false;
          const batch = this.deps.batchStore.get(ref.slice("batch:".length));
          return batch === undefined || (batch.status !== "sealed" && batch.status !== "applied");
        })) {
          return { approved: false, reason: "晋升永久不能引用未封存批次作为证据" };
        }
        const conflict = this.deps.journalStore.listPending(proposal.agentId).some((intent) =>
          intent.targetId === String(current.id) && ["supersede", "merge", "suppress", "forget"].includes(intent.intentType));
        if (conflict) return { approved: false, reason: "目标事实存在未解决冲突" };
      }
      return this.checkWatermark(proposal, [current.id]);
    }

    if (["supersede", "merge"].includes(proposal.type)) {
      const ids: number[] = proposal.type === "merge"
        ? ((proposal.payload.factIds as unknown[] | undefined)?.map(idValue).filter((item): item is number => item !== undefined) ?? [])
        : (factId === undefined ? [] : [factId]);
      if (!ids?.length || ids.some((id) => !this.deps.factStore.getActiveById(id))) return { approved: false, reason: "目标事实版本冲突或已非 active" };
      // 跨 Agent 隔离：merge 的所有目标事实都必须属于当前 Agent
      if (ids.some((id) => this.deps.factStore.getById(id)?.agentId !== proposal.agentId)) return { approved: false, reason: "目标事实不属于当前 Agent" };
      // 版本冲突（自审发现）：提案生成时的 previousState 必须与当前事实一致
      // （fact 文本 + status + revision；status 变化如被其他运行遗忘/取代即冲突，
      // revision 变化如被其他运行提强/激活也冲突——评审 P1#2），
      // 防止提案生成后被其他运行修改仍继续应用（计划 §六"版本冲突会拒绝或重新计算"）
      if (proposal.type === "supersede") {
        const previous = proposal.previousState as Record<string, unknown> | undefined;
        const target = this.deps.factStore.getById(ids[0]!);
        if (!previous || target === undefined || previous["fact"] !== target.fact || previous["status"] !== target.status || previous["revision"] !== target.updatedAt) {
          return { approved: false, reason: "事实版本冲突，请重新计算提案" };
        }
      } else {
        const previousFacts = (proposal.previousState as Record<string, unknown> | undefined)?.["facts"];
        if (!Array.isArray(previousFacts)) return { approved: false, reason: "事实版本冲突，请重新计算提案" };
        for (const id of ids) {
          const target = this.deps.factStore.getById(id);
          const snap = (previousFacts as Array<Record<string, unknown>>).find((entry) => String(entry["id"]) === String(id));
          if (target === undefined || snap === undefined || snap["fact"] !== target.fact || snap["status"] !== target.status || snap["revision"] !== target.updatedAt) {
            return { approved: false, reason: "事实版本冲突，请重新计算提案" };
          }
        }
      }
      const firstId = ids[0];
      if (firstId === undefined) return { approved: false, reason: "目标事实不存在" };
      return this.checkWatermark(proposal, ids);
    }
    if (proposal.type === "forget") {
      if (!proposal.reason.trim()) return { approved: false, reason: "遗忘必须提供理由" };
      if (proposal.targetType === "session") return { approved: false, reason: "暂不支持对会话目标执行遗忘" };
      if (proposal.targetType === "fact" && (!current || current.status === "suppressed")) return { approved: false, reason: "目标事实不存在" };
      // 跨 Agent 隔离：事件目标必须属于当前 Agent
      if (proposal.targetType === "event") {
        const targetEvent = this.deps.eventStore.getById(String(proposal.targetId));
        if (!targetEvent) return { approved: false, reason: "目标事件不存在" };
        if (targetEvent.agentId !== proposal.agentId) return { approved: false, reason: "目标事件不属于当前 Agent" };
      }
      return this.checkWatermark(proposal, factId === undefined ? [] : [factId]);
    }
    if (proposal.type === "restore") {
      if (!current || current.status !== "forgotten") return { approved: false, reason: "只有 forgotten 事实允许恢复" };
      return this.checkWatermark(proposal, [current.id]);
    }
    return { approved: false, reason: "不支持的提案类型" };
  }

  /**
   * 证据归属校验（跨 Agent 隔离 + 防伪造）：
   * - batch:<id> 必须存在且属于当前 Agent；
   * - event:<id> 必须存在且属于当前 Agent；
   * - session:<id> 必须在当前 Agent 的回忆账本中出现过（确定性可验证）。
   */
  private checkEvidenceOwnership(proposal: MemoryMutationProposal): string {
    for (const ref of proposal.evidenceRefs) {
      const colon = ref.indexOf(":");
      const kind = ref.slice(0, colon);
      const id = ref.slice(colon + 1);
      if (kind === "batch") {
        const batch = this.deps.batchStore.get(id);
        if (!batch || batch.agentId !== proposal.agentId) return `证据引用不属于当前 Agent: ${ref}`;
      } else if (kind === "event") {
        const event = this.deps.eventStore.getById(id);
        if (!event || event.agentId !== proposal.agentId) return `证据引用不属于当前 Agent: ${ref}`;
      } else if (kind === "session") {
        const known = this.deps.recallStore.listByAgent(proposal.agentId, { limit: 1_000_000 }).some((entry) => entry.sessionId === id);
        if (!known) return `会话证据无法验证（回忆账本中不存在）: ${ref}`;
      }
    }
    return "";
  }

  /**
   * 供应用层确定性计算新事实初始强度（评审 P0-2：不信任模型显式 retentionStrength，
   * 完全由平台按证据/可信度/用户意图计算；payload schema 已禁止额外字段作为第一道闸）。
   */
  computeInitialRetention(proposal: MemoryMutationProposal): number {
    const settings = this.deps.settingsResolver(proposal.agentId);
    const userIntent = this.deps.journalStore.listPending(proposal.agentId).some((intent) =>
      intent.intentType === "remember" && intent.status === "pending" &&
      typeof intent.payload["fact"] === "string" &&
      intent.payload["fact"] === String(proposal.payload.fact ?? proposal.payload.content ?? "").trim());
    // 会话证据去重（重复提交同一 session 不虚增 independentSessions）
    const sessionRefs = new Set(proposal.evidenceRefs.filter((ref) => ref.startsWith("session:"))).size;
    const computed = computeRetention({
      current: 0,
      signals: { userIntent, independentSessions: sessionRefs, independentDates: 0, consistency: proposal.confidence, conflicts: 0, successUse: 0, ageDays: 0 },
      thresholds: settings.retentionThresholds,
    });
    return computed.proposed;
  }

  /**
   * 平台侧隐式水位线（自审修复）：payload 收紧后模型无法传入 journalWatermark，
   * 改为以提案生成时间（createdAt）为界——之后出现的用户意图说明提案已过期，
   * 拒绝并提示重新计算；水位线完全由平台判定，模型不可伪造。
   *
   * 评审 P0 修复：
   * - actor 同时认 user 与 main_agent（pi-sdk remember/forget 工具写入 main_agent）；
   * - 全量 journal 扫描（默认 50 条截断会漏掉更早的冲突意图）；
   * - merge/supersede 检查全部目标事实（原实现只看第一个）。
   */
  private checkWatermark(proposal: MemoryMutationProposal, targetIds: readonly number[]): MemoryPolicyResult {
    if (targetIds.length === 0) return { approved: true, reason: "策略检查通过" };
    const targets = new Set(targetIds.map(String));
    const newer = this.deps.journalStore.listByAgent(proposal.agentId, { limit: 1_000_000 }).some((intent) =>
      (intent.actor === "user" || intent.actor === "main_agent") &&
      intent.targetId !== undefined && targets.has(intent.targetId) &&
      intent.createdAt > proposal.createdAt);
    return newer ? { approved: false, reason: "提案生成后出现新的用户意图，请重新计算提案" } : { approved: true, reason: "策略检查通过" };
  }
}
