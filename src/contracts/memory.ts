import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// OpenColorful 记忆系统契约（Phase 10 底座 / Phase 10.5 预留）
//
// 权威设计：docs/memory-architecture.md、plans/phase-10.md
//
// 两条通道：
//   1. 上下文记忆通道（四段 Markdown 传送带，自动注入）
//   2. 长期记忆通道（memory_facts，只能由记忆 Agent 提案 + 审批写入）
// PI JSONL 是原始经历唯一事实源；memory_journal 是记忆意志的追加式权威。
// ═══════════════════════════════════════════════════════════════

// ─── 回想（Recall） ─────────────────────────────────────────────

/** search_memory 内部下钻层级：facts → events → source session */
export const MEMORY_RECALL_LAYERS = ["facts", "events", "source"] as const;
export type MemoryRecallLayer = (typeof MEMORY_RECALL_LAYERS)[number];

/** RecallEpisode 状态机 */
export const MEMORY_RECALL_STATUSES = [
  "started",
  "layer_changed",
  "completed",
  "empty",
  "failed",
  "cancelled",
] as const;
export type MemoryRecallStatus = (typeof MEMORY_RECALL_STATUSES)[number];

/** search_memory 的 depth 参数 */
export const MEMORY_SEARCH_DEPTHS = ["quick", "deep", "source"] as const;
export type MemorySearchDepth = (typeof MEMORY_SEARCH_DEPTHS)[number];

/** recall ledger 的命中目标类型 */
export const MEMORY_RECALL_TARGET_TYPES = ["fact", "event", "session"] as const;
export type MemoryRecallTargetType = (typeof MEMORY_RECALL_TARGET_TYPES)[number];

/** 一次多层回想聚合成一个 RecallEpisode，驱动 SSE 状态与 UI 文案 */
export interface RecallEpisode {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: MemoryRecallStatus;
  /** 当前下钻到的层级；仅在 layer_changed 后有意义 */
  readonly layer?: MemoryRecallLayer;
  readonly resultCount: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

/** recall ledger 单条命中记录（activation 的事实来源，Phase 10.5 可重建投影） */
export interface MemoryRecallEntry {
  readonly id: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly recallId: string;
  readonly targetType: MemoryRecallTargetType;
  readonly targetId: string;
  readonly queryHash: string;
  readonly layer: MemoryRecallLayer;
  readonly sourceType: string;
  readonly createdAt: string;
}

// ─── sourceType 与防自我强化 ────────────────────────────────────

/**
 * 内容来源标记。回想结果、注入内容和 Agent 复述不能作为独立强化证据，
 * 防止「越容易搜到越容易被搜到」的反馈循环。
 */
export const MEMORY_SOURCE_TYPES = [
  "original",
  "memory_recall",
  "injected_memory",
  "agent_paraphrase",
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/** 不能作为独立强化证据的来源类型 */
export const NON_EVIDENCE_SOURCE_TYPES: readonly MemorySourceType[] = [
  "memory_recall",
  "injected_memory",
  "agent_paraphrase",
] as const;

// ─── 强度模型（Phase 10 只存 schema；计算与变更属 Phase 10.5） ──

export const MEMORY_STRENGTH_TIERS = ["short", "medium", "permanent"] as const;
export type MemoryStrengthTier = (typeof MEMORY_STRENGTH_TIERS)[number];

export const MEMORY_FACT_STATUSES = ["active", "forgotten", "superseded", "suppressed"] as const;
export type MemoryFactStatus = (typeof MEMORY_FACT_STATUSES)[number];

export const MEMORY_EVENT_STATUSES = ["active", "forgotten", "suppressed"] as const;
export type MemoryEventStatus = (typeof MEMORY_EVENT_STATUSES)[number];

export const MEMORY_FACT_SOURCES = ["agent_proposed", "agent_approved", "user_intent"] as const;
export type MemoryFactSource = (typeof MEMORY_FACT_SOURCES)[number];

/** retention / activation 强度范围 0..100 */
export const STRENGTH_MIN = 0;
export const STRENGTH_MAX = 100;

// ─── 长期记忆记录 ───────────────────────────────────────────────

/** memory_facts 行（Phase 10 只读检索；写入从 Phase 10.5 记忆 Agent 开始） */
export interface MemoryFact {
  readonly id: number;
  readonly agentId: string;
  readonly fact: string;
  readonly searchText: string;
  readonly tags: readonly string[];
  readonly factTime?: string;
  readonly source: MemoryFactSource;
  readonly sourceRefs: readonly string[];
  readonly retentionStrength: number;
  readonly activationStrength: number;
  readonly confidence: number;
  readonly validUntil?: string;
  readonly status: MemoryFactStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** memory_events 行（零额外 LLM 的时间线事件索引） */
export interface MemoryEvent {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly branchRevision: string;
  readonly sourceStartEntry?: string;
  readonly sourceEndEntry?: string;
  readonly date: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly searchText: string;
  readonly messageCount: number;
  readonly toolCalls: number;
  readonly durationSec: number;
  readonly status: MemoryEventStatus;
  readonly createdAt: string;
}

/** session_summaries 行（rolling summary + branch-aware cursor） */
export interface SessionSummary {
  readonly sessionId: string;
  readonly branchRevision: string;
  readonly agentId?: string;
  readonly summary: string;
  readonly messageCount: number;
  /** 增量读取游标：PI entry 身份 + 位置；不以行号作为稳定身份 */
  readonly cursor: Record<string, unknown>;
  readonly sourceStartEntry?: string;
  readonly sourceEndEntry?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── 记忆意志（memory_journal，追加式权威） ─────────────────────

export const MEMORY_JOURNAL_ACTORS = ["user", "main_agent", "memory_agent", "system"] as const;
export type MemoryJournalActor = (typeof MEMORY_JOURNAL_ACTORS)[number];

export const MEMORY_JOURNAL_INTENT_TYPES = [
  "remember",
  "forget",
  "pin",
  "unpin",
  "supersede",
  "merge",
  "suppress",
  "restore",
] as const;
export type MemoryJournalIntentType = (typeof MEMORY_JOURNAL_INTENT_TYPES)[number];

export const MEMORY_JOURNAL_TARGET_TYPES = ["fact", "event", "session", "memory"] as const;
export type MemoryJournalTargetType = (typeof MEMORY_JOURNAL_TARGET_TYPES)[number];

export const MEMORY_JOURNAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "revoked",
] as const;
export type MemoryJournalStatus = (typeof MEMORY_JOURNAL_STATUSES)[number];

/**
 * memory_journal 行。remember/forget 只形成待处理 intent；
 * pin/unpin 属 Markdown 通道由平台即时应用并留痕。
 * rebuild 必须同时读取 JSONL 与本表，否则 forget/delete 后会复活。
 */
export interface MemoryJournalIntent {
  readonly id: string;
  readonly agentId: string;
  readonly actor: MemoryJournalActor;
  readonly intentType: MemoryJournalIntentType;
  readonly targetType: MemoryJournalTargetType;
  readonly targetId?: string;
  readonly payload: Record<string, unknown>;
  readonly status: MemoryJournalStatus;
  readonly createdAt: string;
  readonly appliedAt?: string;
}

// ─── 封存批次（sealed_memory_batch 队列） ───────────────────────

export const MEMORY_BATCH_STATUSES = [
  "provisional",
  "sealed",
  "processing",
  "applied",
  "deferred",
  "failed",
] as const;
export type MemoryBatchStatus = (typeof MEMORY_BATCH_STATUSES)[number];

/**
 * memory_batches 行。Session 结束/归档/长会话 micro-seal 时创建，
 * 是 Phase 10.5 记忆 Agent 的输入；封存不阻塞 Session 关闭。
 * API/UI 的「pending batch」是 provisional/sealed/processing/deferred/failed 的聚合称呼。
 */
export interface MemoryBatch {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  /** 关联的 summary/branch revision 等版本信息 */
  readonly revision: Record<string, unknown>;
  readonly sourceStartEntry?: string;
  readonly sourceEndEntry?: string;
  readonly status: MemoryBatchStatus;
  readonly priority: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── 恢复契约（daily state + watermarks + scheduler） ──────────

/** 每日传送带阶段：S0 compileDaily → S1 compileToday → S2 rollDailyWindow → S3 compileFacts → S4 assemble */
export const MEMORY_DAILY_STEPS = ["S0", "S1", "S2", "S3", "S4"] as const;
export type MemoryDailyStep = (typeof MEMORY_DAILY_STEPS)[number];

export const MEMORY_WATERMARK_SCOPES = ["summary", "events", "markdown", "batch"] as const;
export type MemoryWatermarkScope = (typeof MEMORY_WATERMARK_SCOPES)[number];

/** memory_watermarks 行：branch-aware cursor + dirty 状态 */
export interface MemoryWatermark {
  readonly agentId: string;
  readonly scope: MemoryWatermarkScope;
  readonly branchRevision: string;
  readonly cursor: Record<string, unknown>;
  readonly dirty: boolean;
  readonly updatedAt: string;
}

export const MEMORY_SCHEDULER_STATUSES = ["idle", "running", "deferred", "failed"] as const;
export type MemorySchedulerStatus = (typeof MEMORY_SCHEDULER_STATUSES)[number];

/** scheduler_state 行：运行、延期、失败和下次重试 */
export interface MemorySchedulerState {
  readonly agentId: string;
  readonly status: MemorySchedulerStatus;
  readonly lastDailyDate?: string;
  readonly lastDailyCompletedAt?: string;
  readonly lastWeeklyCompletedAt?: string;
  readonly nextRetryAt?: string;
  readonly updatedAt: string;
}

// ─── Pinned（Markdown 通道，低风险即时应用） ───────────────────

export interface PinnedMemory {
  readonly id: string;
  readonly agentId: string;
  readonly content: string;
  readonly createdAt: string;
}

// ─── search_memory 工具契约 ────────────────────────────────────

/** search_memory 工具参数（LLM 产出，跨进程输入，必须校验） */
export const SearchMemoryArgsSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  depth: Type.Optional(Type.Union(MEMORY_SEARCH_DEPTHS.map((d) => Type.Literal(d)))),
  timeRange: Type.Optional(
    Type.Object({
      from: Type.Optional(Type.String({ minLength: 1 })),
      to: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type SearchMemoryArgs = Static<typeof SearchMemoryArgsSchema>;

/** 单次命中的只读结果：是证据不是指令，带 provenance 与 sourceType */
export interface MemorySearchHit {
  readonly targetType: MemoryRecallTargetType;
  readonly targetId: string;
  readonly layer: MemoryRecallLayer;
  readonly snippet: string;
  readonly provenance: {
    readonly sessionId: string;
    readonly sourceStartEntry?: string;
    readonly sourceEndEntry?: string;
  };
  readonly confidence: number;
  readonly strengthTier?: MemoryStrengthTier;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly sourceType: MemorySourceType;
}

/** search_memory 聚合结果；「没有找到」与「系统失败」是不同结果 */
export interface MemorySearchResult {
  readonly episodeId: string;
  readonly status: Extract<MemoryRecallStatus, "completed" | "empty" | "failed" | "cancelled">;
  readonly hits: readonly MemorySearchHit[];
  /** 实际下钻到的最深层级 */
  readonly reachedLayer: MemoryRecallLayer;
}

// ─── 记忆意图工具参数（intent-only，不授予长期库写权限） ────────

/** remember 工具参数：只追加 memory_journal intent，等 Phase 10.5 审批 */
export const RememberIntentArgsSchema = Type.Object({
  fact: Type.String({ minLength: 1 }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  validUntil: Type.Optional(Type.String({ minLength: 1 })),
});
export type RememberIntentArgs = Static<typeof RememberIntentArgsSchema>;

/** forget 工具参数：只追加 memory_journal intent；隐私删除由平台立即执行 */
export const ForgetIntentArgsSchema = Type.Object({
  targetType: Type.Union(MEMORY_RECALL_TARGET_TYPES.map((t) => Type.Literal(t))),
  targetId: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ minLength: 1 })),
  reason: Type.Optional(Type.String()),
});
export type ForgetIntentArgs = Static<typeof ForgetIntentArgsSchema>;

/** pin_memory 工具参数：Markdown 通道，平台即时应用到 pinned_memories 并留痕 */
export const PinMemoryArgsSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
});
export type PinMemoryArgs = Static<typeof PinMemoryArgsSchema>;

export const UnpinMemoryArgsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
});
export type UnpinMemoryArgs = Static<typeof UnpinMemoryArgsSchema>;

// ─── SSE 事件 payload 契约 ─────────────────────────────────────

/** memory.updated：四段 Markdown 新 revision 发布（下一轮生效），/memory 页自动刷新 */
export const MemoryUpdatedPayloadSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  revision: Type.Optional(Type.String()),
});
export type MemoryUpdatedPayload = Static<typeof MemoryUpdatedPayloadSchema>;

/** memory.recall.*：RecallEpisode 状态广播，可从 memory_recall_events Replay */
export const MemoryRecallPayloadSchema = Type.Object({
  recallId: Type.String({ minLength: 1 }),
  episodeId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.Optional(Type.String()),
  layer: Type.Optional(Type.Union(MEMORY_RECALL_LAYERS.map((l) => Type.Literal(l)))),
  status: Type.Union(MEMORY_RECALL_STATUSES.map((s) => Type.Literal(s))),
  resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type MemoryRecallPayload = Static<typeof MemoryRecallPayloadSchema>;
