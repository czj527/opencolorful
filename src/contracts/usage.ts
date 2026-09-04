/**
 * 统一模型用量契约（波次 A8）。
 *
 * 设计约束（plans/p1-quality-model-usage.en.md A8 节）：
 * - usage_records 是跨来源（主会话 / 子代理 / utility）的 token 用量查询事实；
 *   生命周期与预算事实仍归 subagent_runs 等各自的状态存储，不用一张表替代；
 * - 不记录 cost；不记录 prompt/completion 正文或任何敏感输入；
 * - Provider 未提供的字段以 0/NULL 表达"无账目"，不伪造数值。
 */

export const USAGE_SOURCES = ["main", "subagent", "utility"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_ROLES = ["primary", "secondary"] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

/** 调用终态：budget_exhausted 仅来源于子代理运行预算；utility/main 失败归 failed。 */
export const USAGE_CALL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
  "budget_exhausted",
] as const;
export type UsageCallStatus = (typeof USAGE_CALL_STATUSES)[number];

/** 单次模型调用的 token 账目（与 PI turn.completed payload 的 usage 形状一致）。 */
export interface UsageTokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

/**
 * utility 适配层（completeUtilityText）的结构化返回：
 * text 与调用账目分离；usage 为 null 表示运行时未提供账目（明确语义，不伪造 0）。
 */
export interface UtilityCompletion {
  readonly text: string;
  readonly usage: UsageTokenTotals | null;
}

/** GET /api/usage/summary 响应中按维度分组的聚合行。 */
export interface UsageGroupTotals extends UsageTokenTotals {
  readonly calls: number;
}

/** GET /api/usage/summary 查询过滤参数（全部可选，days 缺省 30）。 */
export interface UsageQueryParams {
  readonly days?: number;
  readonly source?: UsageSource;
  readonly role?: UsageRole;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
}
