import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type Database from "better-sqlite3";

import { Value } from "typebox/value";

import { createApiError } from "../../contracts/api-error.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { RuntimePaths } from "../../config/paths.js";
import { MemoryEventStore } from "../../storage/memory/event-store.js";
import { MemoryFactStore } from "../../storage/memory/fact-store.js";
import { PinnedMemoryStore } from "../../storage/memory/pinned-store.js";
import { MemoryBatchStore } from "../../storage/memory/batch-store.js";
import { MemoryWatermarkStore, SchedulerStateStore } from "../../storage/memory/recovery-store.js";
import { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import { parseMemoryMdSections } from "../../runtime/memory/memory-injection.js";
import type { MemoryAgentResolver } from "../../runtime/memory/resolver.js";
import type { MemoryAgentScheduler } from "../../runtime/memory/scheduler.js";
import type { ProposalApplication } from "../../runtime/memory/proposal-application.js";
import type { PreferencesStore } from "../../config/preferences-store.js";
import {
  MemoryAgentSettingsSchema,
  defaultMemoryAgentSettings,
  isValidRetentionThresholds,
  type MemoryAgentSettings,
} from "../../contracts/memory.js";

function parseTags(value: string | undefined): string[] {
  return value === undefined || value.trim() === ""
    ? []
    : value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function ensureAgent(agentStore: AgentStore | undefined, agentId: string): Response | undefined {
  if (agentStore === undefined) return undefined;
  try { agentStore.load(agentId); return undefined; }
  catch { return new Response(JSON.stringify(createApiError("NOT_FOUND", "Agent 不存在")), { status: 404, headers: { "content-type": "application/json" } }); }
}

export interface MemoryAdminDeps {
  readonly resolver: MemoryAgentResolver;
  readonly application: ProposalApplication;
  readonly preferencesStore: PreferencesStore;
  readonly recallStore: MemoryRecallStore;
  /** 手动 deep-dive 经 Scheduler 的 per-Agent 串行队列（与定时任务不重叠） */
  readonly scheduler?: Pick<MemoryAgentScheduler, "enqueueDeepDive">;
  /** 生效的记忆设置（per-Agent → 全局 → 默认）；deep-dive 尊重 enabled=false */
  readonly settingsResolver: (agentId: string) => MemoryAgentSettings;
}

export function registerMemoryRoutes(
  app: Hono,
  database: Database.Database,
  paths: RuntimePaths,
  agentStore?: AgentStore,
  /** Phase 10 手动 flush 钩子（由组合根注入 MemoryTicker.requestFlush） */
  flushHook?: (agentId: string) => void,
  /** Phase 10.5 管理依赖（deep-dive/rollback/runs/settings/timeline） */
  admin?: MemoryAdminDeps,
): void {
  const facts = new MemoryFactStore(database);
  const events = new MemoryEventStore(database);
  const pinned = new PinnedMemoryStore(database);
  const batches = new MemoryBatchStore(database);
  const watermarks = new MemoryWatermarkStore(database);
  const scheduler = new SchedulerStateStore(database);
  const recalls = new MemoryRecallStore(database);

  app.get("/api/agents/:id/memory/compiled", async (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    let content = "";
    try { content = await fs.readFile(path.join(paths.agents, agentId, "memory", "memory.md"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // 按四段契约切分（与注入共用同一解析器），页面按段展示
    return context.json({ agentId, content, sections: parseMemoryMdSections(content) });
  });

  app.get("/api/agents/:id/memory/facts", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const query = context.req.query("query")?.trim();
    const tags = parseTags(context.req.query("tags"));
    const result = query ? facts.searchByFts(agentId, query) : facts.listByAgent(agentId, { tags });
    const filtered = query && tags.length > 0 ? result.filter((fact) => tags.every((tag) => fact.tags.includes(tag))) : result;
    return context.json({ agentId, facts: filtered });
  });

  app.get("/api/agents/:id/memory/events", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const query = context.req.query("query")?.trim();
    const from = context.req.query("from")?.trim() || undefined;
    const to = context.req.query("to")?.trim() || undefined;
    const range = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    return context.json({ agentId, events: query ? events.searchByFts(agentId, query, range) : events.listByAgentAndDateRange(agentId, from, to) });
  });

  app.get("/api/agents/:id/memory/pinned", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    return context.json({ agentId, pinned: pinned.listByAgent(agentId) });
  });

  app.post("/api/agents/:id/memory/flush", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    // Phase 10 flush：封存活跃 Session + 重建 Markdown/事件索引（fire-and-forget）；
    // 不运行记忆 Agent、不应用长期事实 proposal。
    if (flushHook !== undefined) {
      flushHook(agentId);
      return context.json({ agentId, status: "accepted", implementation: "seal_and_rebuild", message: "已排队封存并重建记忆索引" }, 202);
    }
    return context.json({ agentId, status: "accepted", implementation: "not_implemented_safe", message: "Phase 10 flush 仅返回安全排队确认，不运行记忆 Agent 或写入 memory_facts" }, 202);
  });

  app.get("/api/agents/:id/memory/health", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const latestEpisodes = database.prepare("SELECT * FROM memory_recall_episodes WHERE agent_id = ? ORDER BY started_at DESC LIMIT 20").all(agentId);
    return context.json({
      agentId,
      watermarks: watermarks.listDirty(agentId),
      scheduler: scheduler.get(agentId) ?? { agentId, status: "idle", updatedAt: null },
      pendingBatches: batches.listPendingBatches(agentId),
      latestRecallEpisodes: latestEpisodes,
      latestRecallStatus: latestEpisodes.length > 0 ? (latestEpisodes[0] as { status: string }).status : null,
      recallEvents: latestEpisodes.length > 0 ? recalls.listRecallEventsByEpisode((latestEpisodes[0] as { id: string }).id) : [],
    });
  });

  // ── Phase 10.5 管理端点 ──────────────────────────────────────

  // 手动排队一次整理（仍经 MemoryPolicy；走 Scheduler per-Agent 串行队列）
  app.post("/api/agents/:id/memory/deep-dive", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    if (admin === undefined) {
      return context.json({ agentId, status: "unavailable", message: "记忆 Agent 未启用" }, 503);
    }
    if (!admin.settingsResolver(agentId).enabled) {
      return context.json({ agentId, status: "disabled", message: "记忆 Agent 已关闭，请先在设置中启用" }, 503);
    }
    if (admin.scheduler !== undefined) {
      void admin.scheduler.enqueueDeepDive(agentId).catch(() => undefined);
    } else {
      void admin.resolver.deepDive(agentId).catch(() => undefined);
    }
    return context.json({ agentId, status: "queued", message: "已排队整理，结果将异步更新" }, 202);
  });

  // 反向 journal mutation 回滚指定 run
  app.post("/api/agents/:id/memory/deep-dive/rollback", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const runId = context.req.query("run");
    if (admin === undefined || typeof runId !== "string" || runId.trim() === "") {
      return context.json(createApiError("INVALID_INPUT", "缺少 run 参数或记忆 Agent 未启用"), 400);
    }
    const result = admin.application.rollbackRun({ agentId, runId });
    return context.json({ agentId, runId, applied: result.applied.length, failed: result.failed.length });
  });

  // 读取脱敏运行报告（runs/<ts>/run.json 含 runId；按 runId 匹配）
  app.get("/api/agents/:id/memory/runs/:runId", async (context) => {
    const agentId = context.req.param("id");
    const runId = context.req.param("runId");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const runsDir = path.join(paths.agents, agentId, "memory", "runs");
    let names: string[];
    try { names = await fs.readdir(runsDir); } catch { return context.json(createApiError("NOT_FOUND", "没有运行记录"), 404); }
    for (const name of names) {
      try {
        const runJson = JSON.parse(await fs.readFile(path.join(runsDir, name, "run.json"), "utf8")) as { runId?: string };
        if (runJson.runId === runId) {
          const report = await fs.readFile(path.join(runsDir, name, "REPORT.md"), "utf8").catch(() => "");
          return context.json({ agentId, runId, run: runJson, report });
        }
      } catch { /* 跳过损坏目录 */ }
    }
    return context.json(createApiError("NOT_FOUND", "运行记录不存在"), 404);
  });

  // per-Agent 记忆设置（缺失回退全局默认，GET 返回生效值）
  app.get("/api/agents/:id/memory/settings", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    let effective = defaultMemoryAgentSettings();
    if (admin !== undefined) {
      effective = admin.preferencesStore.get().memory ?? effective;
    }
    try {
      const agentSettings = agentStore?.getSettings(agentId);
      if (agentSettings?.memory !== undefined) effective = agentSettings.memory;
    } catch { /* 读取失败用全局默认 */ }
    return context.json({ agentId, settings: effective });
  });

  app.put("/api/agents/:id/memory/settings", async (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    if (agentStore === undefined) return context.json(createApiError("INVALID_INPUT", "Agent 存储不可用"), 400);
    const raw = await context.req.json() as unknown;
    if (!Value.Check(MemoryAgentSettingsSchema, raw)) {
      return context.json(createApiError("INVALID_INPUT", "记忆设置不合法"), 400);
    }
    // 评审 P1#7a：迟滞阈值必须 mediumDown < mediumUp < permanentUp（{90,10,5} 直接拒绝）
    const settings = raw as MemoryAgentSettings;
    if (!isValidRetentionThresholds(settings.retentionThresholds)) {
      return context.json(createApiError("INVALID_INPUT", "迟滞阈值必须满足 mediumDown < mediumUp < permanentUp"), 400);
    }
    agentStore.saveSettings(agentId, { memory: settings });
    return context.json({ agentId, settings: raw });
  });

  // 全局记忆默认
  app.get("/api/preferences/memory", (context) => {
    if (admin === undefined) return context.json({ settings: defaultMemoryAgentSettings() });
    return context.json({ settings: admin.preferencesStore.get().memory ?? defaultMemoryAgentSettings() });
  });

  app.put("/api/preferences/memory", async (context) => {
    if (admin === undefined) return context.json(createApiError("INVALID_INPUT", "记忆设置不可用"), 400);
    const raw = await context.req.json() as unknown;
    if (!Value.Check(MemoryAgentSettingsSchema, raw)) {
      return context.json(createApiError("INVALID_INPUT", "记忆设置不合法"), 400);
    }
    // 评审 P1#7a：迟滞阈值排序校验（TypeBox 无法表达跨字段约束）
    const settings = raw as MemoryAgentSettings;
    if (!isValidRetentionThresholds(settings.retentionThresholds)) {
      return context.json(createApiError("INVALID_INPUT", "迟滞阈值必须满足 mediumDown < mediumUp < permanentUp"), 400);
    }
    admin.preferencesStore.update({ memory: settings } as never);
    return context.json({ settings: raw });
  });

  // 时间线：事实双强度 + 事件显著度（派生值实时计算，不落库）
  app.get("/api/agents/:id/memory/timeline", (context) => {
    const agentId = context.req.param("id");
    const missing = ensureAgent(agentStore, agentId); if (missing) return missing;
    const from = context.req.query("from")?.trim() || undefined;
    const to = context.req.query("to")?.trim() || undefined;
    const facts = new MemoryFactStore(database).listByAgent(agentId);
    const eventList = events.searchByFts(agentId, "", { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
    const ledger = admin?.recallStore.listByAgent(agentId) ?? [];
    const factTimeline = facts.map((fact) => {
      const hitDates = ledger
        .filter((entry) => entry.targetType === "fact" && entry.targetId === String(fact.id))
        .map((entry) => entry.createdAt);
      return {
        id: fact.id,
        fact: fact.fact,
        retentionStrength: fact.retentionStrength,
        activationStrength: fact.activationStrength,
        confidence: fact.confidence,
        status: fact.status,
        validUntil: fact.validUntil ?? null,
        createdAt: fact.createdAt,
        hitDates: [...new Set(hitDates.map((d) => d.slice(0, 10)))].length,
      };
    });
    const eventTimeline = eventList.map((event) => {
      const hitDates = ledger
        .filter((entry) => entry.targetType === "event" && entry.targetId === event.id)
        .map((entry) => entry.createdAt);
      const recency = Math.max(0, 1 - (Date.now() - Date.parse(`${event.date}T00:00:00Z`)) / (30 * 24 * 3600 * 1000));
      return {
        id: event.id,
        summary: event.summary,
        date: event.date,
        messageCount: event.messageCount,
        toolCalls: event.toolCalls,
        status: event.status,
        salience: Math.round((recency * 0.5 + Math.min(hitDates.length, 14) / 14 * 0.5) * 100),
      };
    });
    return context.json({ agentId, facts: factTimeline, events: eventTimeline });
  });
}
