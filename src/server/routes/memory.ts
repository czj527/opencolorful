import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type Database from "better-sqlite3";

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

export function registerMemoryRoutes(
  app: Hono,
  database: Database.Database,
  paths: RuntimePaths,
  agentStore?: AgentStore,
  /** Phase 10 手动 flush 钩子（由组合根注入 MemoryTicker.requestFlush） */
  flushHook?: (agentId: string) => void,
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
}
