import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import { USAGE_ROLES, USAGE_SOURCES } from "../../contracts/usage.js";
import type { UsageRole, UsageSource } from "../../contracts/usage.js";
import type { UsageStore } from "../../storage/usage-store.js";

const USAGE_SOURCE_VALUES = new Set<string>(USAGE_SOURCES);
const USAGE_ROLE_VALUES = new Set<string>(USAGE_ROLES);

function isUsageSource(value: string): value is UsageSource {
  return USAGE_SOURCE_VALUES.has(value);
}

function isUsageRole(value: string): value is UsageRole {
  return USAGE_ROLE_VALUES.has(value);
}

/** 非空字符串 trim 后透传；空串（或全空白）视为未提供。 */
function parseOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function registerUsageRoutes(app: Hono, usageStore: UsageStore): void {
  app.get("/api/sessions/:id/usage", (context) => {
    const sessionId = context.req.param("id");
    const summary = usageStore.sessionTotals(sessionId);

    const denominator = summary.input + summary.cacheRead;
    const cacheHitRate = denominator > 0 ? summary.cacheRead / denominator : null;

    const contextInfo = summary.contextWindow !== null
      ? {
          tokens: summary.contextTokens,
          contextWindow: summary.contextWindow,
          // 与 PI ContextUsage 语义一致：0-100 百分比
          percent: summary.contextTokens !== null && summary.contextWindow > 0
            ? (summary.contextTokens / summary.contextWindow) * 100
            : null,
        }
      : null;

    return context.json({
      sessionId,
      totals: {
        input: summary.input,
        output: summary.output,
        cacheRead: summary.cacheRead,
        cacheWrite: summary.cacheWrite,
        totalTokens: summary.totalTokens,
      },
      cacheHitRate,
      turns: summary.turns,
      calls: summary.calls,
      context: contextInfo,
    });
  });

  app.get("/api/usage/summary", (context) => {
    const rawDays = context.req.query("days");
    let days = 30;

    if (rawDays !== undefined) {
      const parsed = Number(rawDays);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
        return context.json(createApiError("INVALID_INPUT", "days 必须是 1-365 的整数"), 400);
      }
      days = parsed;
    }

    // 过滤参数全部可选（A8 契约 UsageQueryParams）；非法枚举 400，非空文本 trim 后透传，空串视为未提供。
    // UsageQueryParams 字段为 readonly，此处用等形的可变局部对象逐步装配后整体传入。
    const filter: {
      days: number;
      source?: UsageSource;
      role?: UsageRole;
      agentId?: string;
      sessionId?: string;
      providerId?: string;
      modelId?: string;
    } = { days };

    const rawSource = context.req.query("source");
    if (rawSource !== undefined) {
      if (!isUsageSource(rawSource)) {
        return context.json(
          createApiError("INVALID_INPUT", "source 必须是 main、subagent、utility 之一"),
          400,
        );
      }
      filter.source = rawSource;
    }

    const rawRole = context.req.query("role");
    if (rawRole !== undefined) {
      if (!isUsageRole(rawRole)) {
        return context.json(
          createApiError("INVALID_INPUT", "role 必须是 primary、secondary 之一"),
          400,
        );
      }
      filter.role = rawRole;
    }

    const agentId = parseOptionalText(context.req.query("agentId"));
    if (agentId !== undefined) {
      filter.agentId = agentId;
    }
    const sessionId = parseOptionalText(context.req.query("sessionId"));
    if (sessionId !== undefined) {
      filter.sessionId = sessionId;
    }
    const providerId = parseOptionalText(context.req.query("providerId"));
    if (providerId !== undefined) {
      filter.providerId = providerId;
    }
    const modelId = parseOptionalText(context.req.query("modelId"));
    if (modelId !== undefined) {
      filter.modelId = modelId;
    }

    const result = usageStore.summaryFiltered(filter);

    const denominator = result.totals.input + result.totals.cacheRead;
    const cacheHitRate = denominator > 0 ? result.totals.cacheRead / denominator : null;

    return context.json({
      days: result.days,
      totals: result.totals,
      cacheHitRate,
      sessions: result.sessions,
      turns: result.turns,
      byDay: result.byDay,
      byModel: result.byModel,
      calls: result.calls,
      bySource: result.bySource,
      byRole: result.byRole,
      byStatus: result.byStatus,
    });
  });
}
