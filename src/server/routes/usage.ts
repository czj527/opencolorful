import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { UsageStore } from "../../storage/usage-store.js";

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

    const result = usageStore.summary(days);

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
    });
  });
}
