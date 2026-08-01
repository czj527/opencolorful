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
  /** 高优先级（用户明确「请记住/不要再记得」）→ turn 后 micro-seal 专项处理 */
  readonly priority?: number;
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
  /** 高优先级：用户明确要求立刻记住（0 默认，1-10 提高） */
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
});
export type RememberIntentArgs = Static<typeof RememberIntentArgsSchema>;

/** forget 工具参数：只追加 memory_journal intent；隐私删除由平台立即执行 */
export const ForgetIntentArgsSchema = Type.Object({
  targetType: Type.Union([Type.Literal("fact"), Type.Literal("event"), Type.Literal("session")]),
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

// ─── memory.md 四段契约（assemble 输出 ⇄ 注入切分的对齐点） ────

/**
 * memory.md 四段标题（借 openhanako buildCompiledMemoryMarkdown 结构）。
 * T4 assemble 写盘与 T6 注入切分都以此为准；四个标题始终保留，空段写占位符。
 */
export const MEMORY_MD_SECTION_TITLES = {
  facts: "重要事实",
  today: "今天",
  week: "本周早些时候",
  longterm: "长期情况",
} as const;
export type MemoryMdSectionKey = keyof typeof MEMORY_MD_SECTION_TITLES;

/** 空段占位符（避免格式漂移） */
export const MEMORY_MD_EMPTY_PLACEHOLDER = "（暂无）";

/** 注入总预算（字符），超限按 今天 > 重要事实 > Pinned > 本周 > 长期 截断 */
export const MEMORY_INJECTION_BUDGET_CHARS = 2500;

/** Pinned Memories 独立保底预算（字符） */
export const MEMORY_INJECTION_PINNED_BUDGET_CHARS = 400;

/** 注入块中记忆使用规则标题（位于 Pinned 与 Memory 段之前） */
export const MEMORY_USAGE_RULE_HEADING = "# 记忆使用规则";

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

// ═══════════════════════════════════════════════════════════════
// Phase 10.5：记忆 Agent、强度巩固与审批契约
// 权威设计：plans/phase-10.5.md、docs/memory-architecture.md 第四/六节
// ═══════════════════════════════════════════════════════════════

// ─── 审批提案（MemoryMutationProposal） ─────────────────────────

/** 记忆 Agent 可提出的变更类型（平台校验后单事务应用） */
export const MEMORY_PROPOSAL_TYPES = [
  "create_fact",
  "strength_change",
  "supersede",
  "merge",
  "forget",
  "restore",
  "longterm_projection",
] as const;
export type MemoryProposalType = (typeof MEMORY_PROPOSAL_TYPES)[number];

export const MEMORY_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "reverted",
] as const;
export type MemoryProposalStatus = (typeof MEMORY_PROPOSAL_STATUSES)[number];

/**
 * memory_mutation_proposals 行。记忆 Agent 只产出提案（不直写正式表）；
 * 平台经 MemoryPolicy 校验后在单个 SQLite 事务内应用。
 * previous_state 保存应用前快照，回滚据此生成反向 mutation（actor=system）。
 */
export interface MemoryMutationProposal {
  readonly id: string;
  readonly agentId: string;
  readonly runId: string;
  readonly type: MemoryProposalType;
  readonly targetType?: MemoryRecallTargetType;
  readonly targetId?: string;
  /** 按 type 变化的负载：事实文本/强度值/合并目标/有效期等 */
  readonly payload: Record<string, unknown>;
  /** 应用前快照（strength 旧值/原事实状态等），回滚与审计用 */
  readonly previousState?: Record<string, unknown>;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly confidence: number;
  readonly status: MemoryProposalStatus;
  readonly policyReason?: string;
  readonly createdAt: string;
  readonly appliedAt?: string;
}

/** MemoryPolicy 校验结果 */
export interface MemoryPolicyResult {
  readonly approved: boolean;
  readonly reason: string;
}

/** 记忆 Agent 提案负载 schema（模型输出经严格校验，跨进程输入） */
export const CreateFactProposalPayloadSchema = Type.Object({
  fact: Type.String({ minLength: 1, maxLength: 500 }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  factTime: Type.Optional(Type.String()),
  validUntil: Type.Optional(Type.String()),
});
export type CreateFactProposalPayload = Static<typeof CreateFactProposalPayloadSchema>;

export const StrengthChangeProposalPayloadSchema = Type.Object({
  retentionStrength: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type StrengthChangeProposalPayload = Static<typeof StrengthChangeProposalPayloadSchema>;

export const SupersedeProposalPayloadSchema = Type.Object({
  supersededFactId: Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]),
  newFact: Type.String({ minLength: 1, maxLength: 500 }),
  reason: Type.String(),
});
export type SupersedeProposalPayload = Static<typeof SupersedeProposalPayloadSchema>;

export const MergeProposalPayloadSchema = Type.Object({
  factIds: Type.Array(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]), { minItems: 2 }),
  mergedFact: Type.String({ minLength: 1, maxLength: 500 }),
});
export type MergeProposalPayload = Static<typeof MergeProposalPayloadSchema>;

export const ForgetProposalPayloadSchema = Type.Object({
  targetType: Type.Union([Type.Literal("fact"), Type.Literal("event"), Type.Literal("session")]),
  targetId: Type.String({ minLength: 1 }),
  reason: Type.String(),
});
export type ForgetProposalPayload = Static<typeof ForgetProposalPayloadSchema>;

export const LongtermProjectionProposalPayloadSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 1000 }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type LongtermProjectionProposalPayload = Static<typeof LongtermProjectionProposalPayloadSchema>;

// ─── 记忆 Agent 设置（全局默认 + per-Agent 覆盖） ────────────────

/** 迟滞阈值默认值（短期升中期 45 / 中期降短期 35 / 中期升永久 85） */
export const MEMORY_RETENTION_THRESHOLD_DEFAULTS = {
  mediumUp: 45,
  mediumDown: 35,
  permanentUp: 85,
} as const;

/** activation 独立日期统计封顶（防「越容易搜到越容易被搜到」反馈循环） */
export const MEMORY_ACTIVATION_DATES_CAP = 14;

/** 深度整理模式 */
export const MEMORY_DEEP_DIVE_MODES = ["script", "experimental-agent"] as const;
export type MemoryDeepDiveMode = (typeof MEMORY_DEEP_DIVE_MODES)[number];

/**
 * 记忆整理与强度设置（plans/phase-10.5.md §8.2）。
 * 全局默认存 preferences.json，per-Agent 覆盖存 settings.json（完整对象，非增量合并）。
 */
export const MemoryAgentSettingsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    utilityProviderId: Type.Union([Type.String(), Type.Null()]),
    utilityModel: Type.Union([Type.String(), Type.Null()]),
    deepDiveMode: Type.Union([Type.Literal("script"), Type.Literal("experimental-agent")]),
    dailyRunTime: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    minIdleMinutes: Type.Integer({ minimum: 5, maximum: 180 }),
    weeklyReviewDay: Type.Integer({ minimum: 0, maximum: 6 }),
    weeklyReviewTime: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    turnsPerSummary: Type.Integer({ minimum: 1, maximum: 100 }),
    injectBudgetChars: Type.Integer({ minimum: 200, maximum: 8000 }),
    retentionThresholds: Type.Object({
      mediumUp: Type.Integer({ minimum: 1, maximum: 99 }),
      mediumDown: Type.Integer({ minimum: 1, maximum: 99 }),
      permanentUp: Type.Integer({ minimum: 1, maximum: 99 }),
    }),
  },
  { additionalProperties: false },
);
export type MemoryAgentSettings = Static<typeof MemoryAgentSettingsSchema>;

/** 全局/单 Agent 的默认记忆设置 */
export function defaultMemoryAgentSettings(): MemoryAgentSettings {
  return {
    enabled: true,
    utilityProviderId: null,
    utilityModel: null,
    deepDiveMode: "script",
    dailyRunTime: "03:00",
    minIdleMinutes: 30,
    weeklyReviewDay: 0,
    weeklyReviewTime: "03:30",
    turnsPerSummary: 10,
    injectBudgetChars: 2500,
    retentionThresholds: { ...MEMORY_RETENTION_THRESHOLD_DEFAULTS },
  };
}

// ─── 记忆 Agent 运行与报告 ─────────────────────────────────────

export const MEMORY_RUN_STATUSES = [
  "started",
  "processing",
  "completed",
  "deferred",
  "failed",
  "cancelled",
] as const;
export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number];

/** 一次整理运行的状态（调度器/resolver 与 SSE 共用） */
export interface MemoryRunState {
  readonly runId: string;
  readonly agentId: string;
  readonly status: MemoryRunStatus;
  /** 当前整理阶段（提取/核对/合并/完成…） */
  readonly phase?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly reason?: string;
}

// ─── 10.5 SSE 事件契约 ─────────────────────────────────────────

/** memory.agent.*：后台整理状态（不进入主 Agent 对话消息流） */
export const MemoryAgentPayloadSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal("started"), Type.Literal("processing"), Type.Literal("completed"), Type.Literal("deferred"), Type.Literal("failed"), Type.Literal("cancelled")]),
  phase: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});
export type MemoryAgentPayload = Static<typeof MemoryAgentPayloadSchema>;

/** memory.strength.changed：事实强度变更通知（时间线 UI） */
export const MemoryStrengthChangedPayloadSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  factId: Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]),
  retentionStrength: Type.Integer({ minimum: 0, maximum: 100 }),
  activationStrength: Type.Integer({ minimum: 0, maximum: 100 }),
  previousRetention: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});
export type MemoryStrengthChangedPayload = Static<typeof MemoryStrengthChangedPayloadSchema>;
