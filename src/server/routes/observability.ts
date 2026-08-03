import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type Database from "better-sqlite3";
import type { RuntimePaths } from "../../config/paths.js";
import { PLATFORM_VERSION } from "../../index.js";
import { defaultObservabilityPreferences, type ObservabilityPreferences } from "../../contracts/preferences.js";
import type { ObservabilityHealth } from "../../observability/observability-context.js";
import { ObservabilityQuery, type PageCursor } from "../../observability/observability-query.js";
import { RetentionService } from "../../observability/retention.js";
import { buildSupportBundle } from "../../observability/support-bundle.js";
import { getStreamWatermark, setStreamWatermark } from "../../observability/stream-watermark.js";
import { DiagnosticLogger } from "../../observability/diagnostic-logger.js";
import { assertDurableAudit } from "../../observability/audit-recorder.js";
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
  /** 评审 P0（第三轮）：retention 删除与 Audit 同事务（fail-closed） */
  readonly audit?: import("../../observability/audit-recorder.js").AuditRecorder;
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
  // 评审 P1-7：retention 用到的 logger/spool 也读 observability 偏好
  // （级别/文件大小/磁盘预算/保留期/spool 预算），不再另建一套默认值
  const obsPrefs: ObservabilityPreferences = deps.preferencesStore?.get().observability
    ?? defaultObservabilityPreferences();
  const retentionLogger = new DiagnosticLogger({
    logsRoot: path.join(deps.paths.logs, "runtime", "server"),
    producer: {
      component: "retention", processType: "server", processId: "0",
      bootId: "retention", appVersion: PLATFORM_VERSION, hostPlatform: process.platform,
    },
    fileSizeBytes: obsPrefs.diagnosticFileSizeBytes,
    diskBudgetBytes: obsPrefs.diagnosticDiskBudgetBytes,
    debugRetentionDays: obsPrefs.diagnosticRetentionDays.debug,
    mainRetentionDays: obsPrefs.diagnosticRetentionDays.main,
  });
  const retentionSpool = new EmergencySpool({
    spoolRoot: path.join(deps.paths.logs, "emergency"),
    processType: "server", bootId: "retention",
    budgetBytes: obsPrefs.emergencySpoolBudgetBytes,
  });
  const retention = new RetentionService(deps.database, retentionLogger, retentionSpool, deps.audit);
  /** retention 默认天数：routine 保留期（偏好，缺省 180；PUT 偏好后同步更新） */
  let defaultRetentionDays = obsPrefs.activityRetentionDays.routine;

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
      // 评审 P1-11：重连优先读 Last-Event-ID 头（SSE 标准语义），
      // 再回退 sinceId 查询参数；都不存在时用持久化高水位交接
      const lastEventId = context.req.header("last-event-id");
      const hasLastEventId = lastEventId !== undefined && /^\d+$/.test(lastEventId.trim());
      const sinceRaw = context.req.query("sinceId");
      const hasSince = sinceRaw !== undefined && /^\d+$/.test(sinceRaw);
      let cursor = hasLastEventId ? Number(lastEventId!.trim())
        : hasSince ? Number(sinceRaw)
          : getStreamWatermark(deps.database, channel);
      return streamSSE(context, async (stream) => {
        const abortSignal = context.req.raw.signal;
        let aborted = false;
        const onAbort = (): void => { aborted = true; };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        // 评审 P1-11：cursor 早于当前最小可用 id（retention 删除 / ledger reset 清空旧 epoch）
        // 时发送 reset 控制事件并重置到 minId-1（不重不漏地继续），而不是静默跳过
        let epochSeen = 0;
        const poll = async (): Promise<boolean> => {
          const minId = (deps.database
            .prepare(`SELECT COALESCE(MIN(id), 0) AS minId FROM ${channel}_events`)
            .get() as { minId: number }).minId;
          // 评审 P1-11：游标早于最小可用 id（含表被清空 minId=0）→ reset
          if (cursor > 0 && (minId === 0 || cursor < minId)) {
            const reason = channel === "activity" ? "retention" : "ledger reset";
            await stream.writeSSE({
              event: "reset",
              data: JSON.stringify({
                minAvailableId: minId,
                ...(channel === "audit" ? { currentLedgerEpoch: instrument.getHealth()?.auditEpoch ?? 1 } : {}),
                reason,
              }),
            });
            cursor = minId - 1;
          }
          // 允许 gap：retention 删除的行直接跳过；epoch reset 发 reset 控制事件
          const rows = channel === "activity"
            ? query.listActivityAfterId(cursor, STREAM_BATCH)
            : query.listAuditAfterId(cursor, STREAM_BATCH);
          if (rows.length === 0) return true;
          for (const row of rows) {
            if (aborted) return false;
            if (channel === "audit") {
              const epoch = (row as { ledgerEpoch: number }).ledgerEpoch;
              // 评审 P1-11：reset 只在 epoch 实际变化时发送（原实现每批首行无条件发送）
              if (epochSeen !== 0 && epoch !== epochSeen) {
                await stream.writeSSE({ event: "reset", data: JSON.stringify({ epoch, reason: "ledger epoch" }) });
              }
              epochSeen = epoch;
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
    // 评审 P1（第三轮）：进程名白名单 + resolve 后仍在日志根目录内（防路径穿越/符号链接逃逸）
    const processName = context.req.query("process") ?? "server";
    if (!/^[a-z0-9_-]{1,32}$/i.test(processName)) {
      return context.json({ code: "INVALID_INPUT", message: "进程名不合法" }, 400);
    }
    const fileKind = context.req.query("file") === "debug" ? "debug" : "main";
    const lines = parseOptionalInt(context.req.query("lines") ?? undefined, 200, 1_000);
    const logsRoot = path.resolve(deps.paths.logs);
    const dir = path.resolve(path.join(logsRoot, "runtime", processName));
    if (dir !== path.join(logsRoot, "runtime", processName) || !dir.startsWith(logsRoot + path.sep)) {
      return context.json({ code: "INVALID_INPUT", message: "路径越界" }, 400);
    }
    // 评审 P1（第四轮）：字符串级 resolve 检查挡不住 Junction/符号链接——
    // 目录与最终文件分别做 realpath，真实路径必须仍在日志根内（防读外部文件）
    let logsRootReal: string;
    try { logsRootReal = fs.realpathSync(logsRoot); } catch { logsRootReal = logsRoot; }
    let dirReal: string;
    try { dirReal = fs.realpathSync(dir); } catch { dirReal = dir; }
    if (dirReal !== logsRootReal && !dirReal.startsWith(logsRootReal + path.sep)) {
      return context.json({ code: "INVALID_INPUT", message: "路径越界" }, 400);
    }
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
    // 单文件符号链接同样可能逃逸（目录合法但文件指向外部）
    let fileReal: string;
    try { fileReal = fs.realpathSync(filePath); } catch { fileReal = path.resolve(filePath); }
    if (fileReal !== logsRootReal && !fileReal.startsWith(logsRootReal + path.sep)) {
      return context.json({ code: "INVALID_INPUT", message: "路径越界" }, 400);
    }
    // 评审 P2-12：大日志文件不全量加载——只读文件尾部 TAIL_READ_BYTES 字节
    // （500KB 上限足够覆盖默认 1000 行 × 平均行长的场景）
    const TAIL_READ_BYTES = 512 * 1024;
    const size = fs.statSync(filePath).size;
    const totalBytes = size;
    let content: string;
    if (size <= TAIL_READ_BYTES) {
      content = fs.readFileSync(filePath, "utf8");
    } else {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(TAIL_READ_BYTES);
        const bytes = fs.readSync(fd, buffer, 0, TAIL_READ_BYTES, size - TAIL_READ_BYTES);
        content = buffer.subarray(0, bytes).toString("utf8");
        // 丢掉被截断的半行（从第一个换行开始）
        const firstBreak = content.indexOf("\n");
        if (firstBreak >= 0) content = content.slice(firstBreak + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
    const allLines = content.split("\n").filter((line) => line.trim() !== "");
    const tail = allLines.slice(-lines).slice(-500); // 行数与字节双上限
    return context.json({
      process: processName,
      file: fileName,
      lines: tail.length,
      totalBytes,
      tail,
    });
  });

  // ─── T9：retention / audit reset / export / preferences ───────────

  app.post("/api/observability/retention/preview", async (context) => {
    let body: { days?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
    // 评审 P1-7：默认天数来自偏好 routine 保留期（缺省 180），不再硬编码 30
    const days = typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0 && body.days <= 365
      ? body.days
      : defaultRetentionDays;
    return context.json(retention.previewRetention(days));
  });

  app.post("/api/observability/retention/run", async (context) => {
    let body: { days?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ code: "BAD_REQUEST", message: "需要 JSON body" }, 400); }
    // 评审 P1-7：默认天数来自偏好 routine 保留期（缺省 180），不再硬编码 30
    const days = typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0 && body.days <= 365
      ? body.days
      : defaultRetentionDays;
    // 评审 P0（第三轮）：删除与 Audit 同一事务（fail-closed）——
    // runRetention 内部在聚合/删除的事务里落 audit；审计未被接受 → 删除回滚并 500
    const result = retention.runRetention(days, {
      eventName: "audit.observability.retention_executed",
      payload: {
        action: "observability.retention.executed",
        decision: "allowed",
        changedFields: ["activity_events"],
      },
      actor: { kind: "user", id: "web" },
      executor: { kind: "service", id: "agent-server" },
    });
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
      // 评审 P1（第四轮）：偏好修改影响证据保留策略本身（级别/保留期/预算），
      // 必须留下 durable Activity + 严格 Audit——audit 未配置或被拒 → fail-closed 拒绝。
      // 评审 P1（第五轮）：文件修改采用「audit started → 原子写入 → audit terminal」
      // 模型（docs/logging-architecture.md §6.5）——写盘失败必须留下 failed 终态。
      if (deps.audit === undefined) {
        return context.json({ code: "PROVIDER_UNAVAILABLE", message: "安全审计不可用，偏好修改被拒绝" }, 503 as const);
      }
      // 评审 P1（第六轮）：操作级 operationId——started/completed/failed 共享
      const opId = crypto.randomUUID();
      const opTrace = { traceId: opId, spanId: opId, operationId: opId };
      // 评审 P0（第六轮）：写盘前备份旧偏好，终态失败时恢复并验证
      const previousPrefs = deps.preferencesStore!.get().observability ?? defaultObservabilityPreferences();
      try {
        assertDurableAudit(deps.audit.appendStrict({
          eventName: "audit.observability.preferences_change.started",
          payload: {
            action: "observability.preferences.changed",
            decision: "allowed",
            changedFields: ["diagnosticLevel", "diagnosticDiskBudgetBytes", "diagnosticRetentionDays", "emergencySpoolBudgetBytes", "activityRetentionDays"],
          },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          trace: opTrace,
        }), "可观测性偏好变更");
      } catch {
        return context.json({ code: "PROVIDER_UNAVAILABLE", message: "安全审计不可用，偏好修改被拒绝" }, 503 as const);
      }
      let prefs: ObservabilityPreferences;
      try {
        const result = deps.preferencesStore!.update({ observability: body as never });
        // 评审 P1（第三轮）：偏好更新立即应用到当前运行时（logger/spool 无需重启）；
        // retention 路由的 logger/spool 与默认天数同步重配
        prefs = result.observability ?? defaultObservabilityPreferences();
        instrument.applyObservabilityPreferences(prefs);
        retentionLogger.applyOptions({
          minLevel: prefs.diagnosticLevel,
          diskBudgetBytes: prefs.diagnosticDiskBudgetBytes,
          debugRetentionDays: prefs.diagnosticRetentionDays.debug,
          mainRetentionDays: prefs.diagnosticRetentionDays.main,
        });
        retentionSpool.setBudgetBytes(prefs.emergencySpoolBudgetBytes);
        defaultRetentionDays = prefs.activityRetentionDays.routine;
      } catch (error) {
        // 领域写入失败 → failed 终态（尽力而为），绝不留下 allowed 成功记录
        try {
          deps.audit!.appendStrict({
            eventName: "audit.observability.preferences_change.failed",
            payload: {
              action: "observability.preferences.changed",
              decision: "denied",
              reasonCode: (error instanceof Error ? error.message : String(error)).slice(0, 64),
              changedFields: ["diagnosticLevel", "diagnosticDiskBudgetBytes", "diagnosticRetentionDays", "emergencySpoolBudgetBytes", "activityRetentionDays"],
            },
            actor: { kind: "user", id: "web" },
            executor: { kind: "service", id: "agent-server" },
            trace: opTrace,
          });
        } catch { /* 终态尽力而为 */ }
        return context.json({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "偏好更新失败" }, 400);
      }
      try {
        // 领域写入成功 → completed 终态（原 allowed 记录）
        assertDurableAudit(deps.audit.appendStrict({
          eventName: "audit.observability.preferences_changed",
          payload: {
            action: "observability.preferences.changed",
            decision: "allowed",
            changedFields: ["diagnosticLevel", "diagnosticDiskBudgetBytes", "diagnosticRetentionDays", "emergencySpoolBudgetBytes", "activityRetentionDays"],
          },
          actor: { kind: "user", id: "web" },
          executor: { kind: "service", id: "agent-server" },
          trace: opTrace,
        }), "可观测性偏好变更");
      } catch {
        // 评审 P0（第六轮）：终态审计失败必须可靠补偿——恢复旧偏好并验证
        let compensated = false;
        try {
          deps.preferencesStore!.update({ observability: previousPrefs as never });
          const restored = deps.preferencesStore!.get().observability;
          compensated = restored?.diagnosticLevel === previousPrefs.diagnosticLevel;
        } catch { /* 恢复失败：账本只剩 started，不伪装成功 */ }
        try {
          deps.audit!.appendStrict({
            eventName: "audit.observability.preferences_change.failed",
            payload: {
              action: "observability.preferences.changed",
              decision: "denied",
              reasonCode: compensated ? "audit_terminal_write_failed" : "compensation_failed",
              changedFields: ["diagnosticLevel", "diagnosticDiskBudgetBytes", "diagnosticRetentionDays", "emergencySpoolBudgetBytes", "activityRetentionDays"],
            },
            actor: { kind: "user", id: "web" },
            executor: { kind: "service", id: "agent-server" },
            trace: opTrace,
          });
        } catch { /* 终态尽力而为 */ }
        return context.json({ code: "PROVIDER_UNAVAILABLE", message: compensated ? "安全审计不可用，偏好修改已回滚" : "安全审计不可用，偏好修改已回滚但补偿验证失败" }, 503 as const);
      }
      // durable Activity 证据（audit 已 fail-closed 在前；auditMirror 同库）
      instrument.activity({
        eventName: "observability.preferences.changed",
        actor: { kind: "user", id: "web" },
        executor: { kind: "service", id: "agent-server" },
        payload: { summaryCode: "observability_preferences_changed" },
      });
      instrument.info("preferences.observability.updated", "observability 偏好已更新并应用到当前运行时");
      return context.json(prefs);
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
