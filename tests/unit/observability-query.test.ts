import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityQuery } from "../../src/observability/observability-query.js";
import { getStreamWatermark, setStreamWatermark } from "../../src/observability/stream-watermark.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：查询层（cursor 分页/FTS/错误分组/trace tree/linked graph）
// 完成条件覆盖：cursor gap、retention reset、linked reverse lookup。
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

function makeDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t6-query-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  return { db, directory };
}

function insertActivity(
  db: ReturnType<typeof openMetadataDatabase>,
  overrides: Partial<Record<string, unknown>> = {},
): number {
  const id = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM activity_events").get() as { m: number }).m + 1;
  db.prepare(
    `INSERT INTO activity_events
      (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
       level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
       trace_id, span_id, parent_span_id, operation_id, duration_ms, error_code,
       producer_component, producer_process_type, boot_id, search_text, payload_json)
     VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 'system', 'u', 'service', 'u', ?, ?, ?, ?, ?, ?, ?, 'server', 'boot', ?, '{}')`,
  )
    .run(
      overrides["event_id"] ?? `evt-${id}`,
      overrides["recorded_at"] ?? "2026-08-01T00:00:00.000Z",
      overrides["occurred_at"] ?? "2026-08-01T00:00:00.000Z",
      overrides["event_name"] ?? "system.started",
      overrides["category"] ?? "system",
      overrides["level"] ?? "info",
      overrides["status"] ?? null,
      overrides["significance"] ?? "notable",
      overrides["trace_id"] ?? `trace-${id}`,
      overrides["span_id"] ?? `span-${id}`,
      overrides["parent_span_id"] ?? null,
      overrides["operation_id"] ?? null,
      overrides["duration_ms"] ?? null,
      overrides["error_code"] ?? null,
      overrides["producer_component"] ?? "unit-test",
      overrides["search_text"] ?? `${overrides["event_name"] ?? "system.started"} system`,
    );
  return id;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T6 cursor 分页（recorded_at DESC, id DESC；同时间戳不重不漏）", () => {
  it("相同 recorded_at 的多条记录分页不重复不遗漏", () => {
    const { db } = makeDb();
    // 5 条同时间戳 + 1 条更早
    for (let i = 0; i < 5; i += 1) {
      insertActivity(db, { event_name: "system.started", recorded_at: "2026-08-01T00:00:00.000Z", search_text: "system.started system" });
    }
    insertActivity(db, { event_name: "storage.database.opened", recorded_at: "2026-07-31T00:00:00.000Z", search_text: "storage.database.opened storage" });

    const query = new ObservabilityQuery(db);
    const seen: number[] = [];
    let cursor: { recordedAt: string; id: number } | null = null;
    let pages = 0;
    do {
      const page = query.queryActivities({}, cursor, 2);
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 10) break;
    } while (cursor !== null);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6); // 无重复
    // recorded_at DESC, id DESC：同时间戳按 id 倒序（5→1），更早时间戳最后（6）
    expect(seen).toEqual([5, 4, 3, 2, 1, 6]);
  });

  it("gap：retention 删除中间行后 cursor 继续（允许空洞）", () => {
    const { db } = makeDb();
    for (let i = 0; i < 5; i += 1) {
      insertActivity(db, { event_name: "system.started", recorded_at: "2026-08-01T00:00:00.000Z", search_text: "system.started system" });
    }
    // retention 删除 id 3、4
    db.prepare("DELETE FROM activity_events WHERE id IN (3, 4)").run();
    const query = new ObservabilityQuery(db);
    const page1 = query.queryActivities({}, null, 2);
    expect(page1.items.map((row) => row.id)).toEqual([5, 2]);
    const page2 = query.queryActivities({}, page1.nextCursor, 10);
    expect(page2.items.map((row) => row.id)).toEqual([1]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe("T6 FTS 与过滤", () => {
  it("ASCII search 走 FTS；CJK 回退 LIKE", () => {
    const { db } = makeDb();
    insertActivity(db, { event_name: "turn.completed", category: "turn", search_text: "turn.completed turn turn_completed" });
    insertActivity(db, { event_name: "memory.recall.completed", category: "memory", search_text: "memory.recall.completed memory memory_recall_completed" });
    const query = new ObservabilityQuery(db);
    const ascii = query.queryActivities({ search: "turn.completed" }, null, 10);
    expect(ascii.items.map((row) => row.eventName)).toEqual(["turn.completed"]);
    const cjk = query.queryActivities({ search: "回忆" }, null, 10);
    expect(cjk.items).toHaveLength(0); // LIKE 无匹配（search_text 无中文）
    const byEvent = query.queryActivities({ eventName: "memory.recall.completed" }, null, 10);
    expect(byEvent.items).toHaveLength(1);
    const byTrace = query.queryActivities({ traceId: "trace-2" }, null, 10);
    expect(byTrace.items.map((row) => row.id)).toEqual([2]);
  });
});

describe("T6 错误分组 / 派生指标", () => {
  it("errorGroups 按 event_name+error_code 聚合", () => {
    const { db } = makeDb();
    insertActivity(db, { event_name: "api.request.failed", level: "error", error_code: "E500", recorded_at: "2026-08-01T00:00:00.000Z" });
    insertActivity(db, { event_name: "api.request.failed", level: "error", error_code: "E500", recorded_at: "2026-08-01T01:00:00.000Z" });
    insertActivity(db, { event_name: "model.call.failed", level: "error", error_code: "E429", recorded_at: "2026-08-01T02:00:00.000Z" });
    const query = new ObservabilityQuery(db);
    const groups = query.errorGroups({});
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ eventName: "api.request.failed", errorCode: "E500", count: 2 });
    expect(groups[1]).toMatchObject({ eventName: "model.call.failed", errorCode: "E429", count: 1 });
  });

  it("dailyMetrics 按日聚合 level/status", () => {
    const { db } = makeDb();
    insertActivity(db, { event_name: "turn.completed", level: "info", status: "completed", recorded_at: "2026-08-01T00:00:00.000Z" });
    insertActivity(db, { event_name: "turn.failed", level: "error", status: "failed", recorded_at: "2026-08-01T05:00:00.000Z" });
    insertActivity(db, { event_name: "memory.summary.degraded", level: "warn", status: "degraded", recorded_at: "2026-08-02T00:00:00.000Z" });
    const query = new ObservabilityQuery(db);
    const metrics = query.dailyMetrics({ since: "2026-08-01T00:00:00.000Z" });
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({ date: "2026-08-01", eventCount: 2, errorCount: 1, failedCount: 1 });
    expect(metrics[1]).toMatchObject({ date: "2026-08-02", degradedCount: 1 });
  });
});

describe("T6 trace tree 与 linked graph", () => {
  it("traceTree 按 parentSpanId 重构 span 树", () => {
    const { db } = makeDb();
    insertActivity(db, { event_name: "turn.started", trace_id: "trace-t", span_id: "span-root", parent_span_id: null, recorded_at: "2026-08-01T00:00:00.000Z" });
    insertActivity(db, { event_name: "model.call.started", trace_id: "trace-t", span_id: "span-m1", parent_span_id: "span-root", recorded_at: "2026-08-01T00:00:01.000Z" });
    insertActivity(db, { event_name: "model.call.completed", trace_id: "trace-t", span_id: "span-m2", parent_span_id: "span-m1", recorded_at: "2026-08-01T00:00:02.000Z" });
    const query = new ObservabilityQuery(db);
    const tree = query.traceTree("trace-t");
    expect(tree.total).toBe(3);
    expect(tree.root?.spanId).toBe("span-root");
    expect(tree.root?.children[0]?.spanId).toBe("span-m1");
    expect(tree.root?.children[0]?.children[0]?.spanId).toBe("span-m2");
    expect(query.traceTree("trace-missing").root).toBeNull();
  });

  it("linkedGraph 双向查找（含 reverse）+ bounded truncated", () => {
    const { db } = makeDb();
    db.prepare("INSERT INTO observability_trace_links (source_trace_id, target_trace_id, relation, created_at) VALUES (?, ?, ?, ?)").run("trace-a", "trace-b", "delegated_to", "2026-08-01T00:00:00.000Z");
    db.prepare("INSERT INTO observability_trace_links (source_trace_id, target_trace_id, relation, created_at) VALUES (?, ?, ?, ?)").run("trace-c", "trace-a", "delegated_to", "2026-08-01T00:00:00.000Z");
    const query = new ObservabilityQuery(db);
    const graph = query.linkedGraph("trace-a");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes).toContainEqual({ traceId: "trace-b", relation: "delegated_to", direction: "forward" });
    expect(graph.nodes).toContainEqual({ traceId: "trace-c", relation: "delegated_to", direction: "reverse" });
    expect(graph.truncated).toBe(false);
    // 深度/节点上限
    const bounded = query.linkedGraph("trace-a", { maxDepth: 0, maxNodes: 1 });
    expect(bounded.nodes.length).toBeLessThanOrEqual(1);
    expect(bounded.truncated).toBe(true);
  });

  it("spool import 后的行对 watermark 之后的流可见（高水位交接）", () => {
    const { db } = makeDb();
    expect(getStreamWatermark(db, "activity")).toBe(0);
    const id = insertActivity(db, { event_name: "system.started" });
    setStreamWatermark(db, "activity", id);
    expect(getStreamWatermark(db, "activity")).toBe(id);
    const query = new ObservabilityQuery(db);
    expect(query.listActivityAfterId(id, 10)).toHaveLength(0);
    const id2 = insertActivity(db, { event_name: "system.stopped" }); // 模拟 spool 导入新行
    expect(query.listActivityAfterId(id, 10).map((row) => row.id)).toEqual([id2]);
  });
});
