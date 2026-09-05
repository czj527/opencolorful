import type Database from "better-sqlite3";

import type { UsageCallStatus } from "../../../contracts/usage.js";
import { instrument } from "../../../observability/instrument.js";
import type { UsageStore } from "../../../storage/usage-store.js";
import type { SubagentRunTerminalUsageEvent } from "../stores/run-store.js";
import type { SubagentRunStatus } from "../../../contracts/subagents.js";

// ═══════════════════════════════════════════════════════════════
// 波次 A8a：子代理 Run 终态 → 统一 usage_records 账目摄取。
//
// 摄取点：RunStore.completeRun 持久化累计 token 的同一转换点（终态事务提交后
// 事务外触发，避免嵌套写库）；组合根（composition.ts）把本函数接入 RunStore。
//
// 行语义（usage-store.ts v14）：
// - source=subagent、role=secondary、turnId=null、callId=null；
// - sessionId=parent_session_id、agentId=owner_agent_id、threadId、runId；
// - provider/model 来自 thread 的 model_provider_id/model_id；
// - status 由 run 终态 disposition 映射（见 mapRunStatusToUsageStatus）；
// - 幂等由 dedupe 默认键 `run:<runId>` 保证（重启重放不重复计）。
//
// 摄取失败绝不影响 Run 终态本身（内部 try/catch + instrument.warn）。
// ═══════════════════════════════════════════════════════════════

/** run 终态 → usage_call status 映射（budget_exhausted 仅来源于子代理运行预算）。 */
export function mapRunStatusToUsageStatus(status: SubagentRunStatus): UsageCallStatus | null {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timeout";
    case "interrupted":
      return "interrupted";
    case "budget_exhausted":
      return "budget_exhausted";
    default:
      // 非终态不会到达摄取点（completeRun 只接受终态）；防御性返回 null = 不摄取
      return null;
  }
}

export interface SubagentUsageIngestionDeps {
  readonly usageStore: UsageStore;
  /** thread model_provider_id/model_id 读取（直接 SQL，避免 RunStore→ThreadStore 环） */
  readonly database: Database.Database;
}

/**
 * 构造接入 RunStore.setTerminalUsageIngestion 的摄取回调。
 * 不读取消息/结果正文——只搬运账目数值与关联维度，无敏感内容进入 usage 行。
 */
export function createSubagentUsageIngestion(
  deps: SubagentUsageIngestionDeps,
): (event: SubagentRunTerminalUsageEvent) => void {
  const { usageStore, database } = deps;

  const readThreadModel = (threadId: string): { provider: string; model: string } => {
    const row = database
      .prepare("SELECT model_provider_id, model_id FROM subagent_threads WHERE thread_id = ?")
      .get(threadId) as { model_provider_id: string; model_id: string } | undefined;
    return {
      provider: row?.model_provider_id ?? "unknown",
      model: row?.model_id ?? "unknown",
    };
  };

  return (event) => {
    try {
      const status = mapRunStatusToUsageStatus(event.status);
      if (status === null) {
        return;
      }
      const { provider, model } = readThreadModel(event.threadId);
      usageStore.record({
        source: "subagent",
        role: "secondary",
        status,
        sessionId: event.ownership.parentSessionId,
        agentId: event.ownership.ownerAgentId,
        threadId: event.threadId,
        runId: event.runId,
        provider,
        model,
        input: event.usage.inputTokens,
        output: event.usage.outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: event.usage.totalTokens,
        contextTokens: null,
        contextWindow: null,
        createdAt: event.finishedAt,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
      });
    } catch (error) {
      // 摄取失败不得影响 run 终态（终态事务已提交）；诊断走 instrument
      instrument.warn("usage.subagent.record_failed", "子代理终态用量摄取失败", {
        reason: error instanceof Error ? error.message.slice(0, 160) : "unknown",
      });
    }
  };
}
