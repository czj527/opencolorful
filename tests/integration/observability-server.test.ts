import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { startForegroundServer, type RunningServer } from "../../src/server/start.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T4：真实 server 启动/停止/崩溃链路与一次 Turn 的 trace 还原
// 验证计划完成条件：启动、停止、崩溃、恢复、migration 链路；
// 一次 Turn 可按 trace 还原 turn.started → turn.completed 核心链路。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function makePaths(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return { directory, paths: getRuntimePaths({ OPENCOLORFUL_HOME: directory }) };
}

function query(db: ReturnType<typeof openMetadataDatabase>, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

async function waitFor(db: ReturnType<typeof openMetadataDatabase>, sql: string, params: unknown[], timeoutMs = 8_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let rows: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    rows = query(db, sql, ...params);
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}

afterEach(() => {
  instrument.reset();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T4 server 启动/停止链路埋点", () => {
  it("干净启动：system.starting/started、storage.database.opened、migration.completed、stopping/stopped", async () => {
    const { paths } = makePaths("t4-boot-");
    const server = await startForegroundServer({ host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION });
    await server.stop();

    const db = openMetadataDatabase(paths.database);
    const rows = query(db, "SELECT event_name, status, operation_id, payload_json FROM activity_events ORDER BY id");
    db.close();

    const names = rows.map((row) => row.event_name);
    // 平台边界自动 started/terminal：start 阶段 + storage + migration + stop 阶段
    for (const expected of ["system.starting", "system.started", "storage.database.opened", "storage.migration.completed", "system.stopping", "system.stopped"]) {
      expect(names).toContain(expected);
    }
    const starting = rows.find((row) => row.event_name === "system.starting")!;
    const started = rows.find((row) => row.event_name === "system.started")!;
    const stopping = rows.find((row) => row.event_name === "system.stopping")!;
    const stopped = rows.find((row) => row.event_name === "system.stopped")!;
    expect(starting["status"]).toBe("started");
    expect(started["status"]).toBe("completed");
    expect(starting["operation_id"]).toBe(started["operation_id"]);
    expect(stopping["operation_id"]).toBe(stopped["operation_id"]);
    expect(String(started["operation_id"])).toMatch(/^boot-/);
    // 干净库迁移 1 → 8
    const migration = rows.find((row) => row.event_name === "storage.migration.completed")!;
    expect(JSON.parse(String(migration["payload_json"])).attributes).toEqual({ from: 1, to: CURRENT_SCHEMA_VERSION });
    // boot 阶段序：starting 在 started 前，stopping 在 stopped 前
    expect(names.indexOf("system.starting")).toBeLessThan(names.indexOf("system.started"));
    expect(names.indexOf("system.stopping")).toBeLessThan(names.indexOf("system.stopped"));
  });

  it("崩溃路径：生产资源构建失败 → system.crashed 落库", async () => {
    const { paths } = makePaths("t4-crash-");
    // providers.json 非法 → ModelService.create 失败 → buildProductionResources catch
    fs.mkdirSync(path.dirname(paths.providerSettings), { recursive: true });
    fs.writeFileSync(paths.providerSettings, "{not-json", "utf8");

    await expect(startForegroundServer({ host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION })).rejects.toThrow();

    const db = openMetadataDatabase(paths.database);
    const crashed = db.prepare("SELECT event_name, status, payload_json FROM activity_events WHERE event_name = 'system.crashed'").get() as Record<string, unknown> | undefined;
    db.close();
    expect(crashed).toBeDefined();
    expect(crashed!["status"]).toBe("failed");
    expect(JSON.parse(String(crashed!["payload_json"]))).toMatchObject({ summaryCode: "system_crashed" });
  });
});

describe("T4 一次 Turn 的 trace 还原", () => {
  it("POST 消息 → turn.started/turn.completed 同一 trace，model.call 核心链路可还原", async () => {
    const { paths } = makePaths("t4-turn-");
    const database = openMetadataDatabase(paths.database);
    instrument.init(new ObservabilityContext({
      database,
      producer: {
        component: "integration-test",
        processType: "server",
        processId: String(process.pid),
        bootId: "boot-t4-turn",
        appVersion: PLATFORM_VERSION,
        hostPlatform: process.platform,
      },
      logsRoot: path.join(paths.logs, "runtime", "test"),
      spoolRoot: path.join(paths.logs, "emergency"),
    }));
    const sessionService = new SessionService(paths, new SessionIndex(database));
    const promptService = new PromptService();
    const replayStore = new EventReplayStore();
    const session = sessionService.create({ title: "T4 turn", cwd: process.cwd() });
    session.selectModel("faux", "faux-1");
    const server: RunningServer = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: { sessionService, promptService, replayStore, database },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const sessionId = session.id;

      const accepted = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ content: "hello t4" }),
      });
      expect(accepted.status).toBe(202);

      const db = openMetadataDatabase(paths.database);
      try {
        // 等待终态（turn.started 在 202 后立即落盘，completed 异步完成）
        const completedRows = await waitFor(
          db,
          "SELECT event_name, status, operation_id, trace_id, session_id, executor_kind, executor_id FROM activity_events WHERE event_name = 'turn.completed' ORDER BY id",
          [],
        );
        expect(completedRows.length).toBe(1);
        const completed = completedRows[0]!;
        const started = query(db, "SELECT event_name, status, operation_id, trace_id, session_id, executor_kind FROM activity_events WHERE event_name = 'turn.started' ORDER BY id")[0]!;
        // 一次 Turn 可按 trace 还原：started/completed 同一 traceId 与 operationId
        expect(started["trace_id"]).toBe(completed["trace_id"]);
        expect(started["operation_id"]).toBe(completed["operation_id"]);
        expect(started["operation_id"]).toMatch(/^stream-/);
        expect(started["session_id"]).toBe(sessionId);
        expect(started["executor_kind"]).toBe("agent");
        // session.created 已记录
        const sessionEvents = query(db, "SELECT event_name FROM activity_events WHERE event_name = 'session.created'");
        expect(sessionEvents.length).toBe(1);
        // model.call 链路（faux 也发 message_start/message_end）
        const modelCalls = query(db, "SELECT event_name, trace_id FROM activity_events WHERE event_name IN ('model.call.started','model.call.completed')");
        expect(modelCalls.length).toBeGreaterThanOrEqual(2);
        const modelStarted = modelCalls.find((row) => row.event_name === "model.call.started")!;
        expect(modelStarted["trace_id"]).toBe(started["trace_id"]); // 同一 trace 贯穿模型调用
        // 平台事件（SSE/客户端）不被重复记录为 activity：无 tool 事件（faux 不调用工具）
        const toolEvents = query(db, "SELECT event_name FROM activity_events WHERE event_name LIKE 'tool.%'");
        expect(toolEvents.length).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await server.stop();
      promptService.dispose();
      sessionService.closeAll();
      database.close();
    }
  });
});
