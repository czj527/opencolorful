import crypto from "node:crypto";

import type { PlatformEventEnvelope } from "../contracts/events.js";
import type { UtilityCompletion, UsageRole, UsageTokenTotals } from "../contracts/usage.js";
import type { EventReplayStore, EventSubscriber } from "./event-replay-store.js";
import type { UsageStore } from "../storage/usage-store.js";
import { isAbortLikeError, UtilityTextCallError } from "../pi-sdk/complete-text.js";

export interface ModelResolver {
  (sessionId: string): { providerId: string; modelId: string } | null;
}

/**
 * A8a：主会话 agentId 解析回调。start.ts 接线处从 sessionService.getView(sessionId)
 * 取 agentId（会话不存在/已归档解析失败时返回 null = 未知，不猜测）。
 */
export interface AgentIdResolver {
  (sessionId: string): string | null;
}

interface EventUsageShape {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface EventContextShape {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** 主会话 turn 终态事件 → usage_records 行的 status 映射（A8 冻结契约的 USAGE_CALL_STATUSES）。 */
const TERMINAL_STATUS_BY_EVENT: Record<string, "completed" | "failed" | "cancelled" | "interrupted"> = {
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.cancelled": "cancelled",
  "turn.interrupted": "interrupted",
};

export class UsageRecorder {
  private readonly unsubscribe: () => void;

  constructor(
    replayStore: EventReplayStore,
    private readonly usageStore: UsageStore,
    private readonly resolveModel: ModelResolver,
    private readonly resolveAgentId?: AgentIdResolver,
  ) {
    const subscriber: EventSubscriber = (event) => {
      this.handleEvent(event);
    };
    this.unsubscribe = replayStore.subscribe(subscriber);
  }

  private handleEvent(event: PlatformEventEnvelope): void {
    // 主会话四类 turn 终态各产一行（completed/failed/cancelled/interrupted）；
    // 幂等由 dedupe 默认键 `${sessionId}:${turnId}` 保证——同一 turn 只会有一条行，
    // PI 一次 prompt 只收敛一个终态（mapper.terminal 单次终态约束）。
    const status = TERMINAL_STATUS_BY_EVENT[event.type];
    if (status === undefined) {
      return;
    }
    if (event.sessionId === null) {
      return;
    }

    const payload = event.payload as {
      turnId?: string;
      usage?: EventUsageShape;
      context?: EventContextShape;
    };

    if (payload.turnId === undefined) {
      return;
    }

    // 成功行必须带账目（无 usage 不落行，保持既有语义）；
    // 失败/取消行无账目时按规格落 0（0 = 无账目），保证"失败可查"。
    const usage = payload.usage;
    if (status === "completed" && usage === undefined) {
      return;
    }

    const model = this.resolveModel(event.sessionId);
    const provider = model?.providerId ?? "unknown";
    const modelId = model?.modelId ?? "unknown";

    this.usageStore.record({
      sessionId: event.sessionId,
      turnId: payload.turnId,
      provider,
      model: modelId,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      contextTokens: payload.context?.tokens ?? null,
      contextWindow: payload.context?.contextWindow ?? null,
      createdAt: event.timestamp,
      status,
      agentId: this.resolveAgentId?.(event.sessionId) ?? null,
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

// ── A8a：utility 调用账目摄取（start.ts completeText wrapper 的可测核心）──────

/** utility 调用上下文（provider/model/role 来自模型策略选择结果）。 */
export interface UtilityCallContext {
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly role: UsageRole;
  /** 调用方传入的取消信号（可选）：abort 时该次调用记为 cancelled */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 执行一次 utility 模型调用并落一行 source=utility 账目：
 * - 成功 → completed（usage=null 记 0 = 无账目）；
 * - 失败（stopReason 非法 / 空响应 / 运行时异常）→ failed（Error.usage 可得则记账）；
 * - 取消（AbortSignal 已中止 / abort 类错误）→ cancelled；
 * 摄取失败不影响调用结果本身（吞错 + 诊断），原错误照常上抛。
 */
export async function runUtilityCallWithUsage(
  usageStore: UsageStore,
  context: UtilityCallContext,
  call: () => Promise<UtilityCompletion>,
): Promise<string> {
  const callId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    const completion = await call();
    const finishedAt = new Date().toISOString();
    try {
      usageStore.record({
        source: "utility",
        role: context.role,
        status: "completed",
        provider: context.provider,
        model: context.model,
        agentId: context.agentId,
        sessionId: context.sessionId,
        callId,
        startedAt,
        finishedAt,
        input: completion.usage?.input ?? 0,
        output: completion.usage?.output ?? 0,
        cacheRead: completion.usage?.cacheRead ?? 0,
        cacheWrite: completion.usage?.cacheWrite ?? 0,
        totalTokens: completion.usage?.totalTokens ?? 0,
        createdAt: finishedAt,
      });
    } catch {
      // 摄取失败不掩盖调用结果
    }
    return completion.text;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const cancelled = isAbortLikeError(error, context.signal);
    const usage: UsageTokenTotals | null = error instanceof UtilityTextCallError ? error.usage : null;
    try {
      usageStore.record({
        source: "utility",
        role: context.role,
        status: cancelled ? "cancelled" : "failed",
        provider: context.provider,
        model: context.model,
        agentId: context.agentId,
        sessionId: context.sessionId,
        callId,
        startedAt,
        finishedAt,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        createdAt: finishedAt,
      });
    } catch {
      // 摄取失败不掩盖原错误
    }
    throw error;
  }
}
