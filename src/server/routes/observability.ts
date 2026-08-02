import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type Database from "better-sqlite3";
import type { RuntimePaths } from "../../config/paths.js";
import { PLATFORM_VERSION } from "../../index.js";
import type { ObservabilityHealth } from "../../observability/observability-context.js";
import { ObservabilityQuery, type PageCursor } from "../../observability/observability-query.js";
import { RetentionService } from "../../observability/retention.js";
import { buildSupportBundle } from "../../observability/support-bundle.js";
import { getStreamWatermark, setStreamWatermark } from "../../observability/stream-watermark.js";
import { DiagnosticLogger } from "../../observability/diagnostic-logger.js";
import { EmergencySpool } from "../../observability/emergency-spool.js";
import { CURRENT_SCHEMA_VERSION } from "../../storage/migrations.js";
import { instrument } from "../../observability/instrument.js";
import {
  CLIENT_EVENT_MAX_BODY_BYTES,
  ClientEventRateLimiter,
  isLocalUiOrigin,
  parseClientEvent,
} from "../observability/client-events.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：可观测性查询/实时/健康接口（plans/phase-11.md §十）
//
// - Activity/Audit cursor 分页（recorded_at DESC, id DESC；gap 允许）；
// - 按通道独立的 operator SSE：cursor=表 id，重连 Last-Event-ID 补发
//   （不重不漏），retention/epoch reset 走 reset 控制事件；
// - 查询/实时交接用 observability_state 高水位；
// - 受限 client-events（Origin/Content-Type/body size/schema/双层限速）。
// ═══════════════════════════════════════════════════════════════

export interface ObservabilityRouteDeps {
  readonly database: Database.Database;
  readonly paths: RuntimePaths;
  readonly getHealth: () => ObservabilityHealth | undefined;
  /** observability 偏好读写（GET/PUT /api/preferences/observability） */
  readonly preferencesStore?: import("../../config/preferences-store.js").PreferencesStore;
}

const STREAM_POLL_MS = 1_000;
const STREAM_BATCH = 200;

function parseCursor(value: string | undefined): PageCursor | null {
  if (value === undefined || value === "") return null;
  const [recordedAt, idRaw] = value.split("|");
  const id = Number(idRaw);
  if (recordedAt === undefined || !Number.isInteger(id) || id < 0) return null;
  return { recordedAt, id };
}

function formatCursor(cursor: PageCursor | null): string | null {
  return cursor === null ? null : `${cursor.recordedAt}|${cursor.id}`;
}

function parseOptionalInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

export function registerObservabilityRoutes(app: Hono, deps: ObservabilityRouteDeps): void {
  const query = new ObservabilityQuery(deps.database);
  const limiter = new ClientEventRateLimiter();
  // retention/export 用的 logger/spool 只做文件级操作（与进程内实例同目录）
  const retentionLogger = new DiagnosticLogger({
    logsRoot: path.join(deps.paths.logs, "runtime", "server"),
    producer: {
      component: "retention", processType: "server", processId: "0",
      bootId: "retention", appVersion: PLATFORM_VERSION, hostPlatform: process.platform,
    },
  });
  const retentionSpool = new EmergencySpool({
    spoolRoot: path.join(deps.paths.logs, "emergency"),
    processType: "server", bootId: "retention",
  });
  const retention = new RetentionService(deps.database, retentionLogger, retentionSpool);

  // ─── Activity 查询 ─────────────────────────────────────────────

  app.get("/api/observability/activity", (context) => {
    const filter = {
      ...(context.req.query("from") !== undefined ? { from: context.req.query("from")! } : {}),
      ...(context.req.query("to") !== undefined ? { to: context.req.query("to")! } : {}),
      ...(context.req.query("ownerAgentId") !== undefined ? { ownerAgentId: context.req.query("ownerAgentId")! } : {}),
      ...(context.req.query("sessionId") !== undefined ? { sessionId: context.req.query("sessionId")! } : {}),
      ...(context.req.query("eventName") !== undefined ? { eventName: context.req.query("eventName")! } : {}),
      ...(context.req.query("category") !== undefined ? { category: context.req.query("category")! } : {}),
      ...(context.req.query("level") !== undefined ? { level: context.req.query("level")! } : {}),
      ...(context.req.query("status") !== undefined ? { status: context.req.query("status")! } : {}),
      ...(context.req.query("significance") !== undefined ? { significance: context.req.query("significance")! } : {}),
      ...(context.req.query("component") !== undefined ? { component: context.req.query("component")! } : {}),
      ...(context.req.query("errorCode") !== undefined ? { errorCode: context.req.query("errorCode")! } : {}),
      ...(context.req.query("traceId") !== undefined ? { traceId: context.req.query("traceId")! } : {}),
      ...(context.req.query("operationId") !== undefined ? { operationId: context.req.query("operationId")! } : {}),
      ...(context.req.query("search") !== undefined ? { search: context.req.query("search")! } : {}),
    };
    const cursor = parseCursor(context.req.query("cursor") ?? undefined);
    const limit = parseOptionalInt(context.req.query("limit") ?? undefined, 50, 200);
    const result = query.queryActivities(filter, cursor, limit);
    return context.json({
      items: result.items,
      nextCursor: formatCursor(result.nextCursor),
    });
  });

  // ─── operator SSE：按通道独立，cursor=表 id + 高水位交接 ────────

  const registerStream = (channel: "activity" | "audit"): void => {
    app.get(`/api/observability/${channel}/stream`, (context) => {
      const sinceRaw = context.req.query("sinceId");
      const hasSince = sinceRaw !== undefined && /^\d+$/.test(sinceRaw);
      let cursor = hasSince ? Number(sinceRaw) : getStreamWatermark(deps.database, channel);
      return streamSSE(context, async (stream) => {
        const abortSignal = context.req.raw.signal;
        let aborted = false;
        const onAbort = (): void => { aborted = true; };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        const poll = async (): Promise<boolean> => {
          // 允许 gap：retention 删除的行直接跳过；epoch reset 发 reset 控制事件
          const rows = channel === "activity"
            ? query.listActivityAfterId(cursor, STREAM_BATCH)
            : query.listAuditAfterId(cursor, STREAM_BATCH);
          if (rows.length === 0) return true;
          let epochSent = false;
          for (const row of rows) {
            if (aborted) return false;
            if (channel === "audit") {
              const epoch = (row as { ledgerEpoch: number }).ledgerEpoch;
              if (!epochSent) {
                await stream.writeSSE({ event: "reset", data: JSON.stringify({ epoch, reason: "ledger epoch" }) });
                epochSent = true;
              }
            }
            await stream.writeSSE({
              id: String(row.id),
              event: channel,
              data: JSON.stringify(row),
            });
            cursor = row.id;
          }
          setStreamWatermark(deps.database, channel, cursor);
          return true;
        };

        try {
          await poll();
          const timer = setInterval(() => {
            void poll().then((ok) => {
              if (!ok) clearInterval(timer);
            }).catch(() => { /* 写失败（连接已断）忽略 */ });
          }, STREAM_POLL_MS);
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          clearInterval(timer);
        } finally {
          abortSignal.removeEventListener("abort", onAbort);
        }
      });
    });
  };
  registerStream("activity");
  registerStream("audit");

  app.get("/api/observability/activity/:eventId", (context) => {
    const row = query.getActivity(context.req.param("eventId"));
    if (row === null) return context.json({ code: "NOT_FOUND", message: "事件不存在" }, 404);
    return context.json(row);
  });

  // ─── Audit 查询 ────────────────────────────────────────────────

  app.get("/api/observability/audit", (context) => {
    const epoch = parseOptionalInt(context.req.query("epoch") ?? undefined, 0, Number.MAX_SAFE_INTEGER);
    const filter = {
      ...(epoch > 0 ? { epoch } : {}),
      ...(context.req.query("action") !== undefined ? { action: context.req.query("action")! } : {}),
      ...(context.req.query("decision") !== undefined ? { decision: context.req.query("decision")! } : {}),
      ...(context.req.query("ownerAgentId") !== undefined ? { ownerAgentId: context.req.query("ownerAgentId")! } : {}),
      ...(context.req.query("sessionId") !== undefined ? { sessionId: context.req.query("sessionId")! } : {}),
      ...(context.req.query("traceId") !== undefined ? { traceId: context.req.query("traceId")! } : {}),
    };
    const cursor = parseCursor(context.req.query("cursor") ?? undefined);
    const limit = parseOptionalInt(context.req.query("limit") ?? undefined, 50, 200);
    const result = query.queryAudit(filter, cursor, limit);
    return context.json({
      items: result.items,
      nextCursor: formatCursor(result.nextCursor),
    });
  });

  // ─── trace / linked graph ──────────────────────────────────────

  app.get("/api/observability/traces/:traceId", (context) => {
    const traceId = context.req.param("traceId");
    const tree = query.traceTree(traceId);
    const linked = context.req.query("linked") === "1" || context.req.query("linked") === "true"
      ? query.linkedGraph(traceId, {
          ...(context.req.query("maxDepth") !== undefined ? { maxDepth: parseOptionalInt(context.req.query("maxDepth")!, 4, 16) } : {}),
          ...(context.req.query("maxNodes") !== undefined ? { maxNodes: parseOptionalInt(context.req.query("maxNodes")!, 50, 200) } : {}),
        })
      : undefined;
    return context.json({ trace: tree, ...(linked !== undefined ? { linked } : {}) });
  });

  // ─── 错误分组 / 派生指标 / health ─────────────────────────────

  app.get("/api/observability/errors", (context) => {
    const groups = query.errorGroups({
      ...(context.req.query("since") !== undefined ? { since: context.req.query("since")! } : {}),
      ...(context.req.query("eventName") !== undefined ? { eventName: context.req.query("eventName")! } : {}),
      ...(context.req.query("limit") !== undefined ? { limit: parseOptionalInt(context.req.query("limit")!, 50, 200) } : {}),
    });
    return context.json({ items: groups });
  });

  app.get("/api/observability/metrics", (context) => {
    const metrics = query.dailyMetrics({
      ...(context.req.query("since") !== undefined ? { since: context.req.query("since")! } : {}),
      ...(context.req.query("ownerAgentId") !== undefined ? { ownerAgentId: context.req.query("ownerAgentId")! } : {}),
      ...(context.req.query("days") !== undefined ? { days: parseOptionalInt(context.req.query("days")!, 30, 365) } : {}),
    });
    return context.json({ items: metrics });
  });

  app.get("/api/observability/health", (context) => {
    const health = deps.getHealth();
    if (health === undefined) {
      return context.json({ status: "unavailable", reason: "可观测性未初始化" }, 503);
    }
    return context.json({ status: "ok", ...health });
  });

  // ─── diagnostic tail ───────────────────────────────────────────

  app.get("/api/observability/diagnostic/tail", (context) => {
    const processName = context.req.query("process") ?? "server";
    const fileKind = context.req.query("file") === "debug" ? "debug" : "main";
    const lines = parseOptionalInt(context.req.query("lines") ?? undefined, 200, 1_000);
    const dir = path.join(deps.paths.logs, "runtime", processName);
    if (!fs.existsSync(dir)) {
      return context.json({ process: processName, file: fileKind, lines: 0, totalBytes: 0, tail: [] });
    }
    const files = fs.readdirSync(dir)
      .filter((name) => fileKind === "debug"
        ? name.endsWith(".debug.jsonl")
        : name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))
      .sort()
      .reverse();
    if (files.length === 0) {
      return context.json({ process: processName, file: fileKind, lines: 0, totalBytes: 0, tail: [] });
    }
    const fileName = files[0]!;
    const filePath = path.join(dir, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    const allLines = raw.split("\n").filter((line) => line.trim() !== "");
    const tail = allLines.slice(-lines).slice(-500); // 行数与字节双上限
    return context.json({
      process: processName,
      file: fileName,
      lines: tail.length,
      totalBytes: Buffer.byteLength(raw, "utf8"),
      tail,
    });
  });

  // ─── T9：retention / audit reset / export / preferences ───────────

  app.post("/api/observability/retention/preview", async (context) => {
    let body: { days?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
    const days = typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0 && body.days <= 365
      ? body.days
      : 30;
    return context.json(retention.previewRetention(days));
  });

  app.post("/api/observability/retention/run", async (context) => {
    let body: { days?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
    const days = typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0 && body.days <= 365
      ? body.days
      : 30;
    const result = retention.runRetention(days);
    // 运维动作本身进入 audit（计划 §九：日志清理与 ledger reset 本身进入 Audit）
    // 清理本身进入 Audit（auditMirror：audit.storage.retention_run）
    instrument.activity({
      eventName: "storage.retention.run.completed",
      status: "completed",
      operationId: `retention-${days}-${Date.now()}`,
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
      payload: {
        summaryCode: "storage_retention_run_completed",
        attributes: { days, aggregated: result.aggregated, deleted: result.deleted },
      },
    });
    return context.json(result);
  });

  app.post("/api/observability/audit/reset", async (context) => {
    let body: { confirm?: unknown; reason?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
    if (body.confirm !== true) {
      return context.json({ code: "CONFIRM_REQUIRED", message: "必须显式 confirm: true" }, 400);
    }
    const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.slice(0, 256) : "手动重置";
    // 预览当前 epoch 记录数（显式确认前的最后一眼）
    const epoch = instrument.getHealth()?.auditEpoch ?? 1;
    const targetCount = (deps.database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE ledger_epoch = ?").get(epoch) as { n: number }).n;
    const result = instrument.resetAuditLedger({ actor: { kind: "user", id: "web" }, reason, targetCount });
    if (result === undefined) return context.json({ code: "UNAVAILABLE", message: "可观测性未初始化" }, 503);
    return context.json(result);
  });

  app.post("/api/observability/export", async (context) => {
    let body: { traceId?: unknown } = {};
    try { body = await context.req.json(); } catch { /* 空 body 也可导出 */ }
    const traceId = typeof body.traceId === "string" && body.traceId.trim() !== "" ? body.traceId.trim().slice(0, 64) : undefined;
    const result = buildSupportBundle({
      paths: deps.paths,
      appVersion: PLATFORM_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      database: deps.database,
      query,
      health: deps.getHealth(),
      ...(traceId !== undefined ? { traceId } : {}),
    });
    // 导出本身进入 Audit（auditMirror：audit.storage.export）
    instrument.activity({
      eventName: "storage.export.completed",
      status: "completed",
      operationId: `export-${Date.now()}`,
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
      payload: { summaryCode: "storage_export_completed" },
    });
    return context.json({ path: result.path, manifest: result.manifest });
  });

  if (deps.preferencesStore !== undefined) {
    app.get("/api/preferences/observability", (context) => {
      const prefs = deps.preferencesStore!.get().observability;
      return context.json(prefs ?? {});
    });
    app.put("/api/preferences/observability", async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
      try {
        const result = deps.preferencesStore!.update({ observability: body as never });
        instrument.info("preferences.observability.updated", "observability 偏好已更新");
        return context.json(result.observability ?? {});
      } catch (error) {
        return context.json({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "偏好更新失败" }, 400);
      }
    });
  }

  // ─── 受限 client-events ────────────────────────────────────────

  app.post("/api/observability/client-events", async (context) => {
    // 1. Origin：仅本机 UI（127.0.0.1/localhost）
    if (!isLocalUiOrigin(context.req.header("origin"))) {
      return context.json({ code: "FORBIDDEN", message: "非本机 UI Origin" }, 403 as const);
    }
    // 2. Content-Type
    const contentType = context.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return context.json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "需要 application/json" }, 415 as const);
    }
    // 3. body 上限 64KB
    const body = await context.req.arrayBuffer();
    if (body.byteLength > CLIENT_EVENT_MAX_BODY_BYTES) {
      return context.json({ code: "PAYLOAD_TOO_LARGE", message: "body 超过 64KB" }, 413 as const);
    }
    // 4. 双层速率限制（每客户端按 IP）
    const clientIp = (context.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || "local";
    const limit = limiter.allow(clientIp);
    if (!limit.ok) {
      return context.json({ code: "RATE_LIMITED", message: "请求过于频繁", retryAfterMs: limit.retryAfterMs }, 429 as const);
    }
    // 5. schema 校验
    let parsed: ReturnType<typeof parseClientEvent>;
    try {
      parsed = parseClientEvent(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return context.json({ code: "BAD_REQUEST", message: "JSON 解析失败" }, 400);
    }
    if (!parsed.ok) {
      return context.json({ code: "BAD_REQUEST", message: parsed.reason }, parsed.status as 400);
    }
    // 6. 平台重新盖章持久化（忽略客户端 eventId/actor/scope/trace/producer）
    instrument.activity({
      eventName: parsed.event.eventName,
      status: "failed",
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
      payload: {
        summaryCode: parsed.event.eventName.replace(/\./g, "_"),
        attributes: { message: parsed.event.message, ...(parsed.event.attributes ?? {}) },
      },
    });
    return context.json({ ok: true }, 202);
  });
}
