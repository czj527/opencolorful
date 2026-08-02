import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { RetentionService } from "../../src/observability/retention.js";
import { DiagnosticLogger } from "../../src/observability/diagnostic-logger.js";
import { buildSupportBundle } from "../../src/observability/support-bundle.js";
import { ObservabilityQuery } from "../../src/observability/observability-query.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T9：幂等 retention/聚合/导出
// 完成条件：重复 retention 结果一致；删除前已聚合；诊断包不包含
// 事实源正文和凭据；导出不修改任何源日志。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

const producer: ProducerContext = {
  component: "unit-test",
  processType: "server",
  processId: "1",
  bootId: "boot-test",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

function makeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t9-ret-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  const logger = new DiagnosticLogger({
    logsRoot: path.join(directory, "logs", "runtime", "server"),
    producer,
  });
  const retention = new RetentionService(db, logger);
  return { directory, db, logger, retention };
}

function insertOldActivity(
  db: ReturnType<typeof openMetadataDatabase>,
  recordedAt: string,
  eventName = "turn.completed",
  level = "info",
  status = "completed",
): void {
  db.prepare(
    `INSERT INTO activity_events
      (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
       level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
       trace_id, span_id, producer_component, producer_process_type, boot_id, search_text, payload_json)
     VALUES (?, 1, 1, ?, ?, ?, 'turn', ?, ?, 'routine',
       'system', 'u', 'service', 'u', 'trace-1', 'span-1', 'unit-test', 'server', 'boot', ?, '{"summaryCode":"x"}')`,
  )
    .run(`evt-${Math.random().toString(16).slice(2, 10)}`, recordedAt, recordedAt, eventName, level, status, eventName);
}

function insertOldAudit(db: ReturnType<typeof openMetadataDatabase>, recordedAt: string): void {
  db.prepare(
    `INSERT INTO audit_events
      (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
       action, decision, actor_kind, actor_id, executor_kind, executor_id, trace_id, payload_json)
     VALUES (?, 1, 1, 1, ?, ?, 'audit.agent.deleted', 'allowed', 'user', 'u', 'service', 'u', 'trace-1', '{}')`,
  )
    .run(`audit-${Math.random().toString(16).slice(2, 10)}`, recordedAt, recordedAt);
}

function activityCount(db: ReturnType<typeof openMetadataDatabase>): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T9 幂等 retention", () => {
  it("删除前已聚合：旧行聚合进 daily metrics 后删除；audit 不参与", () => {
    const { db, retention } = makeFixture();
    insertOldActivity(db, "2026-01-01T00:00:00.000Z", "turn.completed");
    insertOldActivity(db, "2026-01-01T01:00:00.000Z", "turn.completed");
    insertOldActivity(db, "2026-01-02T00:00:00.000Z", "turn.failed");
    insertOldActivity(db, "2026-07-15T00:00:00.000Z", "system.started"); // 30 天内保留
    insertOldAudit(db, "2026-01-01T00:00:00.000Z"); // audit 永不参与 retention

    const result = retention.runRetention(30);
    expect(result.deleted).toBe(3);
    expect(result.aggregated).toBe(3);
    // 已聚合进 daily metrics（删除前聚合）
    const metrics = db.prepare("SELECT metric_date, metric_kind, value_json FROM activity_daily_metrics ORDER BY metric_date").all() as Array<{ metric_date: string; value_json: string }>;
    expect(metrics.length).toBe(2);
    expect(metrics[0]?.metric_date).toBe("2026-01-01");
    // 近 30 天行保留
    expect(activityCount(db)).toBe(1);
    const kept = db.prepare("SELECT event_name FROM activity_events").all() as Array<{ event_name: string }>;
    expect(kept[0]?.event_name).toBe("system.started");
    // audit 原样保留
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(1);
    // watermark 已写
    expect(retention.getWatermark()).not.toBe("");
  });

  it("重复执行结果一致：第二次不再聚合/删除，metrics 不重复累计", () => {
    const { db, retention } = makeFixture();
    insertOldActivity(db, "2026-01-01T00:00:00.000Z", "turn.completed");
    insertOldActivity(db, "2026-01-01T01:00:00.000Z", "turn.completed");

    const first = retention.runRetention(30);
    expect(first.deleted).toBe(2);
    const second = retention.runRetention(30);
    expect(second.deleted).toBe(0);
    expect(second.aggregated).toBe(0);
    // metrics 不重复累计
    const metrics = db.prepare("SELECT SUM(json_extract(value_json, '$.count')) AS total FROM activity_daily_metrics").get() as { total: number };
    expect(metrics.total).toBe(2);
    expect(activityCount(db)).toBe(0);
  });

  it("preview 只读：不影响任何数据", () => {
    const { db, retention } = makeFixture();
    insertOldActivity(db, "2026-01-01T00:00:00.000Z");
    const before = activityCount(db);
    const preview = retention.previewRetention(30);
    expect(preview.activityRows).toBe(1);
    expect(preview.oldestRecordedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(activityCount(db)).toBe(before);
    expect(retention.getWatermark()).toBe("");
  });

  it("diagnostic 文件清理：过期 debug 文件删除，预览一致", () => {
    const { db, logger, retention } = makeFixture();
    const logDir = path.join(logger["logsRoot"] as unknown as string);
    fs.mkdirSync(logDir, { recursive: true });
    const oldDate = "2026-01-01";
    fs.writeFileSync(path.join(logDir, `${oldDate}_boot_0.debug.jsonl`), "old\n");
    fs.writeFileSync(path.join(logDir, `${oldDate}_boot_0.jsonl`), "old-main\n");
    const preview = retention.previewRetention(30);
    expect(preview.logFilesToDelete.length).toBe(2);
    const result = retention.runRetention(30);
    expect(result.logFilesDeleted.length).toBe(2);
    expect(fs.existsSync(path.join(logDir, `${oldDate}_boot_0.debug.jsonl`))).toBe(false);
    expect(activityCount(db)).toBe(0);
  });
});

describe("T9 support bundle", () => {
  it("导出不修改源日志；bundle 无 payloadJson 原文与凭据", () => {
    const { directory, db } = makeFixture();
    insertOldActivity(db, "2026-01-01T00:00:00.000Z");
    insertOldActivity(db, "2026-07-15T00:00:00.000Z", "model.call.failed", "error", "failed");
    // 源日志文件（含模拟敏感内容）
    const logDir = path.join(directory, "logs", "runtime", "server");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "2026-08-01_boot_0.jsonl");
    fs.writeFileSync(logFile, '{"message":"sk-abc123456789 secret"}', "utf8");
    const logBytesBefore = fs.statSync(logFile).size;

    const paths = {
      home: directory,
      logs: path.join(directory, "logs"),
      providerSettings: path.join(directory, "providers.json"),
      preferences: path.join(directory, "preferences.json"),
    } as unknown as import("../../src/config/paths.js").RuntimePaths;
    fs.writeFileSync(paths.providerSettings, '{"openai":{"apiKey":"sk-super-secret"}}', "utf8");

    const result = buildSupportBundle({
      paths,
      appVersion: "0.0.0-test",
      schemaVersion: 8,
      database: db,
      query: new ObservabilityQuery(db),
      health: undefined,
    });

    // 源未被修改/删除
    expect(fs.statSync(logFile).size).toBe(logBytesBefore);
    expect(fs.readFileSync(paths.providerSettings, "utf8")).toContain("sk-super-secret"); // 源配置原样
    expect(fs.existsSync(result.path)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(result.path, "utf8")) as Record<string, unknown>;
    const manifest = bundle["manifest"] as Record<string, unknown>;
    expect(manifest["rawPayloadIncluded"]).toBe(false);
    expect(manifest["factSourcesIncluded"]).toBe(false);
    expect(manifest["rawLogsIncluded"]).toBe(false);
    // 不含 payloadJson 原文、事实正文、凭据（configShape 只有键名）
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("payloadJson");
    expect(serialized).not.toContain("summaryCode");
    expect(serialized).not.toContain("sk-abc123456789");
    expect(serialized).not.toContain("sk-super-secret");
    // failed activity allowlist 存在
    const failed = bundle["failedActivity"] as Array<{ eventName: string }>;
    expect(failed.some((row) => row.eventName === "model.call.failed")).toBe(true);
  });
});

describe("Phase 11 复审修复（评审 P0-4 / P1-5 复现级测试）", () => {
  function insertWithSignificance(
    db: ReturnType<typeof openMetadataDatabase>,
    recordedAt: string,
    significance: "routine" | "notable" | "milestone",
    eventName: string,
  ): void {
    db.prepare(
      `INSERT INTO activity_events
        (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
         level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
         trace_id, span_id, producer_component, producer_process_type, boot_id, search_text, payload_json)
       VALUES (?, 1, 1, ?, ?, ?, 'agent', 'info', 'completed', ?,
         'system', 'u', 'service', 'u', 'trace-1', 'span-1', 'unit-test', 'server', 'boot', ?, '{"summaryCode":"x"}')`,
    )
      .run(`evt-${Math.random().toString(16).slice(2, 10)}`, recordedAt, recordedAt, eventName, significance, eventName);
  }

  it("P0-4：同日期 routine/notable/milestone 三行，retention 只删 routine（notable/milestone 承诺长期保留）", () => {
    const { db, retention } = makeFixture();
    insertWithSignificance(db, "2026-01-01T00:00:00.000Z", "routine", "turn.completed");
    insertWithSignificance(db, "2026-01-01T01:00:00.000Z", "notable", "provider.configured");
    insertWithSignificance(db, "2026-01-01T02:00:00.000Z", "milestone", "agent.created");

    const result = retention.runRetention(30);
    expect(result.deleted).toBe(1); // 只删 routine
    const remaining = db.prepare("SELECT event_name, significance FROM activity_events ORDER BY id").all() as Array<{ event_name: string; significance: string }>;
    expect(remaining.map((row) => row.significance).sort()).toEqual(["milestone", "notable"]);
    // notable/milestone 也进聚合（指标完整），但行本身保留
    const metrics = db.prepare("SELECT SUM(json_extract(value_json, '$.count')) AS total FROM activity_daily_metrics").get() as { total: number };
    expect(metrics.total).toBe(3);
  });

  it("P1-5：水位闭区间——watermark 当天新增的行在下一次 cutoff 推进时被聚合，不会永远落在开区间外", () => {
    const { db, retention } = makeFixture();
    // 第一次 retention：watermark = cutoff（2026-07-03 左右）
    insertOldActivity(db, "2026-01-01T00:00:00.000Z", "turn.completed");
    const first = retention.runRetention(30);
    expect(first.deleted).toBe(1);
    const watermark = retention.getWatermark();
    expect(watermark).not.toBe("");
    // watermark 当天新增一条（模拟 cutoff 日晚上产生的数据）
    insertOldActivity(db, `${watermark}T12:00:00.000Z`, "turn.completed");
    // cutoff 推进一天后再次 retention：watermark 当天的行必须被聚合+删除
    const second = retention.runRetention(29);
    expect(second.aggregated).toBe(1);
    expect(second.deleted).toBe(1);
    expect(activityCount(db)).toBe(0);
  });

  it("P1-5：dailyMetrics 读取 activity_daily_metrics（聚合结果不再因行删除而丢失）", () => {
    const { db, retention } = makeFixture();
    insertOldActivity(db, "2026-01-01T00:00:00.000Z", "turn.completed");
    insertOldActivity(db, "2026-01-01T01:00:00.000Z", "turn.failed", "info", "failed");
    retention.runRetention(30);
    // 行已删除，但指标必须仍可读
    expect(activityCount(db)).toBe(0);
    const query = new ObservabilityQuery(db);
    const metrics = query.dailyMetrics({ since: "2026-01-01T00:00:00.000Z" });
    const jan1 = metrics.find((metric) => metric.date === "2026-01-01");
    expect(jan1).toBeDefined();
    expect(jan1?.eventCount).toBe(2);
    // turn.failed（status=failed，测试 seed 用 level=info）计入 failedCount
    expect(jan1?.failedCount).toBe(1);
    // 实时部分（watermark 之后未聚合行）也计入：不丢新数据
    insertOldActivity(db, new Date().toISOString(), "turn.completed");
    const withLive = query.dailyMetrics({ days: 30 });
    const today = new Date().toISOString().slice(0, 10);
    expect(withLive.find((metric) => metric.date === today)?.eventCount).toBe(1);
  });
});
