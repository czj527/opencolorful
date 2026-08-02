import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { createServerApp } from "../../src/server/app.js";
import { PLATFORM_VERSION } from "../../src/index.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：查询/实时流/client-events API
// 完成条件覆盖：数据库重连（SSE 断线重连不重不漏）、cursor gap、
// spool import（高水位之后可见）、retention reset（gap 继续）、
// linked reverse lookup、恶意客户端输入（Origin/类型/大小/schema/限速）。
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t6-api-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(paths.logs, "runtime", "server"),
    spoolRoot: path.join(paths.logs, "emergency"),
  });
  instrument.init(context);
  const { app } = createServerApp({
    version: PLATFORM_VERSION,
    pid: process.pid,
    startedAt: Date.now(),
    paths,
    database: db,
  });
  return { directory, paths, db, context };
}

function activityInput(eventName: string, patch: Record<string, unknown> = {}): import("../../src/observability/activity-recorder.js").ActivityRecordInput {
  return {
    eventName,
    payload: { summaryCode: eventName.replace(/\./g, "_"), ...patch },
    actor: { kind: "system" as const, id: "unit-test" },
    executor: { kind: "service" as const, id: "unit-test" },
  };
}

async function startServer(app: ReturnType<typeof createServerApp>["app"]): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolve({ server, port: info.port });
    });
    server.once("error", reject);
  });
}

/** 从 SSE 响应流读取直到取到 expected 个事件或超时 */
async function readSseEvents(
  response: Response,
  expected: number,
  timeoutMs = 5_000,
): Promise<Array<{ id: string; event: string; data: unknown }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ id: string; event: string; data: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < expected && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // race：deadline 可中断 in-flight read（无新事件的 SSE 连接保持打开）
      const outcome = await Promise.race([
        reader.read().then((result) => ({ ...result, timedOut: false as const })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining + 50)),
      ]);
      if (outcome.timedOut) break;
      if (outcome.done) break;
      buffer += decoder.decode(outcome.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const id = block.match(/^id: (.+)$/m)?.[1] ?? "";
        const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
        const dataLine = block.match(/^data: (.+)$/m)?.[1];
        if (dataLine !== undefined) {
          events.push({ id, event, data: JSON.parse(dataLine) });
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
}

afterEach(async () => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T6 查询端点", () => {
  it("activity 查询 + cursor 分页 + trace 详情 + linked graph", async () => {
    const { db } = makeFixture();
    const r1 = instrument.activity(activityInput("system.started"))!;
    const r2 = instrument.activity(activityInput("turn.completed"))!;
    if (r1.kind !== "accepted" || r2.kind !== "accepted") throw new Error("seed failed");
    db.prepare("INSERT INTO observability_trace_links (source_trace_id, target_trace_id, relation, created_at) VALUES (?, ?, ?, ?)")
      .run("trace-linked-a", "trace-linked-b", "delegated_to", "2026-08-01T00:00:00.000Z");
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths: getRuntimePaths({ OPENCOLORFUL_HOME: temporaryDirectories[0]! }),
      database: db,
    });
    const base = `http://127.0.0.1`;
    // 直接 app.request（无需监听端口）
    const list = await app.request(`${base}/api/observability/activity?limit=1`);
    const listBody = await list.json() as { items: Array<{ id: number }>; nextCursor: string | null };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.nextCursor).not.toBeNull();
    const page2 = await (await app.request(`${base}/api/observability/activity?limit=10&cursor=${encodeURIComponent(listBody.nextCursor!)}`)).json() as { items: Array<{ id: number }> };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).not.toBe(listBody.items[0]!.id);
    // 单条详情
    const detail = await app.request(`${base}/api/observability/activity/${r1.eventId}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { eventName: string };
    expect(detailBody.eventName).toBe("system.started");
    // trace 详情（无数据 → root null）+ linked graph
    const trace = await (await app.request(`${base}/api/observability/traces/trace-linked-a?linked=1`)).json() as { trace: { root: unknown }; linked: { nodes: Array<{ traceId: string; direction: string }> } };
    expect(trace.trace.root).toBeNull();
    expect(trace.linked.nodes).toContainEqual({ traceId: "trace-linked-b", relation: "delegated_to", direction: "forward" });
    // 错误分组 / 指标 / health
    const errors = await (await app.request(`${base}/api/observability/errors`)).json() as { items: unknown[] };
    expect(Array.isArray(errors.items)).toBe(true);
    const metrics = await (await app.request(`${base}/api/observability/metrics`)).json() as { items: unknown[] };
    expect(metrics.items.length).toBeGreaterThan(0);
    const health = await app.request(`${base}/api/observability/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { status: string; auditEpoch: number };
    expect(healthBody).toMatchObject({ status: "ok", auditEpoch: 1 });
  });

  it("diagnostic tail 返回最新 JSONL 尾部", async () => {
    const { paths } = makeFixture();
    const logDir = path.join(paths.logs, "runtime", "server");
    fs.mkdirSync(logDir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(logDir, `2026-08-01_boot_0.jsonl`), `${JSON.stringify({ seq: i, message: `line-${i}` })}\n`, { flag: "a" });
    }
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths,
      database: openDatabases[openDatabases.length - 1]!,
    });
    const response = await app.request(`http://127.0.0.1/api/observability/diagnostic/tail?lines=3`);
    const body = await response.json() as { lines: number; tail: string[] };
    expect(body.lines).toBe(3);
    expect(JSON.parse(body.tail[2]!)).toMatchObject({ seq: 4 });
  });
});

describe("T6 operator SSE（重连不重不漏 / gap / spool import 高水位）", () => {
  it("sinceId 回放 → 新行推送 → 重连不重复", async () => {
    const { db } = makeFixture();
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths: getRuntimePaths({ OPENCOLORFUL_HOME: temporaryDirectories[0]! }),
      database: db,
    });
    const base = "http://127.0.0.1";
    // 预置三条 + 一条 gap 删除
    const r1 = instrument.activity(activityInput("system.started"))!;
    const r2 = instrument.activity(activityInput("turn.completed"))!;
    const r3 = instrument.activity(activityInput("model.call.completed"))!;
    const ids = [r1, r2, r3].map((r) => (r.kind === "accepted" ? r.rowId : -1));
    db.prepare("DELETE FROM activity_events WHERE id = ?").run(ids[1]!); // retention 删除中间行（gap）

    // 连接 sinceId=0 → 回放剩余行（gap 允许）
    const replay = await readSseEvents(await app.request(`${base}/api/observability/activity/stream?sinceId=0`), 2);
    expect(replay.map((e) => (e.data as { id: number }).id)).toEqual([ids[0], ids[2]]);
    const lastId = replay[1]!.id;

    // 触发新行 → 实时推送
    const r4 = instrument.activity(activityInput("system.stopped"))!;
    const live = await readSseEvents(await app.request(`${base}/api/observability/activity/stream?sinceId=${lastId}`), 1);
    expect((live[0]!.data as { eventName: string }).eventName).toBe("system.stopped");
    expect(live[0]!.id).toBe(String(r4.kind === "accepted" ? r4.rowId : "?"));

    // 重连 with Last-Event-ID 语义（sinceId=最后 id）→ 无重复回放（等一个 poll 周期无事件）
    const reconnect = await readSseEvents(await app.request(`${base}/api/observability/activity/stream?sinceId=${live[0]!.id}`), 1, 1_500);
    expect(reconnect).toHaveLength(0);
  });
});

describe("T9 retention / audit reset / export 端点", () => {
  function seedOldRows(db: ReturnType<typeof openMetadataDatabase>, recordedAt: string): void {
    db.prepare(
      `INSERT INTO activity_events
        (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
         level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
         trace_id, span_id, producer_component, producer_process_type, boot_id, search_text, payload_json)
       VALUES (?, 1, 1, ?, ?, 'turn.completed', 'turn', 'info', 'completed', 'routine',
         'system', 'u', 'service', 'u', 'trace-1', 'span-1', 'unit-test', 'server', 'boot', 'turn.completed', '{}')`,
    )
      .run(`evt-${Math.random().toString(16).slice(2, 10)}`, recordedAt, recordedAt);
  }

  it("retention preview 只读 + run 幂等（删除前聚合、audit 不动）", async () => {
    const { db, paths } = makeFixture();
    seedOldRows(db, "2026-01-01T00:00:00.000Z");
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths,
      database: db,
    });
    const base = "http://127.0.0.1";
    const preview = await (await app.request(`${base}/api/observability/retention/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 30 }),
    })).json() as { activityRows: number };
    expect(preview.activityRows).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n).toBe(1); // preview 只读
    const run = await (await app.request(`${base}/api/observability/retention/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 30 }),
    })).json() as { aggregated: number; deleted: number };
    expect(run.deleted).toBe(1);
    expect(run.aggregated).toBe(1);
    // 聚合已落 metrics；audit 不动；剩余 activity 只有 run 端点自身的镜像事件
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_daily_metrics").get() as { n: number }).n).toBe(1);
    const remaining = db.prepare("SELECT event_name FROM activity_events").all() as Array<{ event_name: string }>;
    expect(remaining).toEqual([{ event_name: "storage.retention.run.completed" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'audit.storage.retention_run'").get() as { n: number }).n).toBe(1);
    // 幂等：重复执行一致
    const again = await (await app.request(`${base}/api/observability/retention/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 30 }),
    })).json() as { deleted: number };
    expect(again.deleted).toBe(0);
  });

  it("audit reset 需要显式 confirm；确认后 epoch+1 且旧记录清理（reset 记录 + audit 镜像）", async () => {
    const { db, paths } = makeFixture();
    // 先造一条 audit（镜像一条 activity 即可触发）
    instrument.activity({
      eventName: "sandbox.path.denied",
      status: "denied",
      operationId: `sb-${Date.now()}`,
      actor: { kind: "agent", id: "a1" },
      executor: { kind: "agent", id: "a1" },
      scope: { ownerAgentId: "a1" },
      payload: { summaryCode: "sandbox_path_denied", attributes: { operation: "read", level: "BLOCKED" } },
    });
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths,
      database: db,
    });
    const base = "http://127.0.0.1";
    // 无 confirm → 400
    const noConfirm = await app.request(`${base}/api/observability/audit/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "测试" }),
    });
    expect(noConfirm.status).toBe(400);
    // 显式确认 → 成功
    const reset = await (await app.request(`${base}/api/observability/audit/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, reason: "测试重置" }),
    })).json() as { newEpoch: number; deleted: number };
    expect(reset.newEpoch).toBe(2);
    expect(reset.deleted).toBe(1);
    const rows = db.prepare("SELECT action, ledger_epoch FROM audit_events").all() as Array<{ action: string; ledger_epoch: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "audit.ledger_reset", ledger_epoch: 2 });
  });

  it("export 生成 bundle：manifest 隐私标志、路径防穿越（不含用户输入）", async () => {
    const { db, paths } = makeFixture();
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths,
      database: db,
    });
    const response = await app.request("http://127.0.0.1/api/observability/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "any-trace" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { path: string; manifest: { rawPayloadIncluded: boolean; factSourcesIncluded: boolean; rawLogsIncluded: boolean; includedSections: string[] } };
    expect(fs.existsSync(body.path)).toBe(true);
    expect(body.path).toContain(path.join("logs", "runtime", "exports"));
    expect(body.manifest).toMatchObject({ rawPayloadIncluded: false, factSourcesIncluded: false, rawLogsIncluded: false });
    // 导出镜像进入 audit
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'audit.storage.export'").get() as { n: number }).n).toBe(1);
  });
});

describe("T6 client-events 安全矩阵", () => {
  async function post(app: ReturnType<typeof createServerApp>["app"], body: unknown, headers: Record<string, string> = {}) {
    return app.request("http://127.0.0.1/api/observability/client-events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("恶意/异常输入全部拒绝：Origin、Content-Type、大小、未知事件、缺 message", async () => {
    const { db } = makeFixture();
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths: getRuntimePaths({ OPENCOLORFUL_HOME: temporaryDirectories[0]! }),
      database: db,
    });
    // 1. 非本机 Origin → 403
    const badOrigin = await post(app, { eventName: "client.unhandled_error", message: "x" }, { origin: "https://evil.example.com" });
    expect(badOrigin.status).toBe(403);
    // 2. 缺失 Origin → 403
    const noOrigin = await post(app, { eventName: "client.unhandled_error", message: "x" }, { origin: "" });
    expect(noOrigin.status).toBe(403);
    // 3. 错误 Content-Type → 415
    const badType = await post(app, { eventName: "client.unhandled_error", message: "x" }, { "content-type": "text/plain" });
    expect(badType.status).toBe(415);
    // 4. body 超 64KB → 413
    const bigBody = JSON.stringify({ eventName: "client.unhandled_error", message: "y".repeat(70 * 1024) });
    const tooBig = await post(app, bigBody);
    expect(tooBig.status).toBe(413);
    // 5. 未知事件 → 400
    const unknown = await post(app, { eventName: "client.hacked", message: "x" });
    expect(unknown.status).toBe(400);
    // 6. 缺 message → 400
    const noMessage = await post(app, { eventName: "client.unhandled_error" });
    expect(noMessage.status).toBe(400);
    // 7. 非 JSON → 400
    const notJson = await post(app, "not-json{");
    expect(notJson.status).toBe(400);
    // 全部未落库
    const count = (db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("合法上报 → 202 + 平台重新盖章（忽略客户端权威字段）+ 敏感内容脱敏", async () => {
    const { db } = makeFixture();
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths: getRuntimePaths({ OPENCOLORFUL_HOME: temporaryDirectories[0]! }),
      database: db,
    });
    const response = await post(app, {
      eventName: "client.unhandled_error",
      message: "render failed with sk-abc123456789 and Authorization: Bearer tok-xyz",
      attributes: { component: "chat", api_key: "sk-secret", url: "https://evil.com?q=1" },
      eventId: "client-forged-id",
      actor: { kind: "user", id: "forged" },
      trace: { traceId: "forged-trace", spanId: "s" },
      producer: { component: "forged", processType: "plugin", processId: "1", bootId: "b", appVersion: "1", hostPlatform: "x" },
    });
    expect(response.status).toBe(202);
    const row = db.prepare("SELECT event_name, actor_id, trace_id, payload_json, producer_component FROM activity_events").get() as Record<string, unknown>;
    expect(row["event_name"]).toBe("client.unhandled_error");
    expect(row["actor_id"]).toBe("web"); // 客户端伪造 actor 被忽略
    expect(String(row["trace_id"])).not.toBe("forged-trace");
    expect(String(row["producer_component"])).not.toBe("forged");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("sk-abc123456789");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("tok-xyz");
    expect(serialized).not.toContain("evil.com");
    expect(serialized).not.toContain("api_key"); // 敏感键名剔除
    expect(serialized).not.toContain("client-forged-id");
    const payload = JSON.parse(String(row["payload_json"])) as { summaryCode: string; attributes: { component: string } };
    expect(payload.summaryCode).toBe("client_unhandled_error");
    expect(payload.attributes.component).toBe("chat");
  });

  it("双层限速：第 61 个请求（同客户端）→ 429，且不落库", async () => {
    const { db } = makeFixture();
    const { app } = createServerApp({
      version: PLATFORM_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      paths: getRuntimePaths({ OPENCOLORFUL_HOME: temporaryDirectories[0]! }),
      database: db,
    });
    let lastStatus = 0;
    for (let i = 0; i < 61; i += 1) {
      const response = await post(app, { eventName: "client.unhandled_error", message: `err-${i}` });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n;
    expect(count).toBe(60);
  });
});
