import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T4：Instrument 平台埋点门面
// - 未 init 时全部 no-op（工具进程/测试不引入埋点依赖）；
// - lifecycle 平台自动产生 started/terminal，终态事件名按映射、唯一终态；
// - 便捷方法事件名/summaryCode 固定，audit 镜像同库落盘。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

const producer: ProducerContext = {
  component: "agent-server",
  processType: "server",
  processId: "1",
  bootId: "boot-test",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

function makeContext(): { context: ObservabilityContext; db: ReturnType<typeof openMetadataDatabase> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t4-instrument-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(directory, "logs"),
    spoolRoot: path.join(directory, "spool"),
  });
  instrument.init(context);
  return { context, db };
}

afterEach(() => {
  instrument.reset(); // 清空单例，避免跨测试污染
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* 已关闭则忽略 */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function count(db: ReturnType<typeof openMetadataDatabase>, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe("T4 Instrument：未 init no-op", () => {
  it("未初始化时所有方法不抛错、不落盘", () => {
    instrument.reset();
    expect(instrument.isEnabled()).toBe(false);
    expect(instrument.activity({
      eventName: "system.starting",
      status: "started",
      actor: { kind: "system", id: "x" },
      executor: { kind: "service", id: "x" },
      payload: { summaryCode: "x" },
    })).toBeUndefined();
    const lifecycle = instrument.startLifecycle({
      startEventName: "turn.started",
      actor: { kind: "user", id: "web" },
      executor: { kind: "agent", id: "a" },
      operationId: "op-1",
    });
    expect(lifecycle.started).toBeUndefined();
    expect(() => {
      lifecycle.complete();
      lifecycle.fail("boom");
      instrument.systemStarting();
      instrument.info("test.event", "msg");
      instrument.runWithTrace({ trace: { traceId: "t", spanId: "s" } }, () => 1);
    }).not.toThrow();
  });
});

describe("T4 Instrument：lifecycle 平台自动 started/terminal", () => {
  it("turn 生命周期：started → completed，终态事件名按映射", () => {
    const { db } = makeContext();
    const lifecycle = instrument.startLifecycle({
      startEventName: "turn.started",
      actor: { kind: "user", id: "web" },
      executor: { kind: "agent", id: "agent-a" },
      target: { kind: "turn", id: "stream-1" },
      scope: { ownerAgentId: "agent-a", sessionId: "session-1" },
      operationId: "stream-1",
      terminals: {
        completed: "turn.completed",
        failed: "turn.failed",
        cancelled: "turn.cancelled",
        interrupted: "turn.interrupted",
      },
      startPayload: { attributes: { providerId: "faux", modelId: "faux-1" } },
    });
    expect(lifecycle.started?.kind).toBe("accepted");
    lifecycle.complete();
    const started = db.prepare("SELECT event_name, status, operation_id, trace_id, payload_json FROM activity_events WHERE event_name = 'turn.started'").get() as Record<string, unknown>;
    const completed = db.prepare("SELECT event_name, status, duration_ms, payload_json FROM activity_events WHERE event_name = 'turn.completed'").get() as Record<string, unknown>;
    expect(started).toBeDefined();
    expect(started["status"]).toBe("started");
    expect(started["operation_id"]).toBe("stream-1");
    expect(JSON.parse(String(started["payload_json"]))).toMatchObject({
      summaryCode: "turn_started",
      attributes: { providerId: "faux", modelId: "faux-1" },
    });
    expect(completed["status"]).toBe("completed");
    expect(completed["duration_ms"]).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(String(completed["payload_json"])).summaryCode).toBe("turn_completed");
  });

  it("同 operationId 重复终态 → 幂等（唯一终态）", () => {
    const { db } = makeContext();
    const lifecycle = instrument.startLifecycle({
      startEventName: "model.call.started",
      actor: { kind: "user", id: "web" },
      executor: { kind: "agent", id: "a" },
      target: { kind: "provider", id: "p1" },
      operationId: "model-s1-1",
      terminals: { completed: "model.call.completed", failed: "model.call.failed" },
    });
    lifecycle.complete();
    lifecycle.complete(); // 重复终态：幂等，不产生新行
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'model.call.completed'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events")).toBe(2); // started + 唯一终态
  });

  it("fail 路径：错误信息经 sanitizeError 脱敏", () => {
    const { db } = makeContext();
    const lifecycle = instrument.startLifecycle({
      startEventName: "turn.started",
      actor: { kind: "user", id: "web" },
      executor: { kind: "agent", id: "a" },
      operationId: "op-fail",
      terminals: { failed: "turn.failed", cancelled: "turn.cancelled" },
    });
    lifecycle.fail(new Error("boom with sk-abcdef123456 and /home/user/secret"));
    const row = db.prepare("SELECT payload_json FROM activity_events WHERE event_name = 'turn.failed'").get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { summaryCode: string; attributes: { message: string } };
    expect(payload.summaryCode).toBe("turn_failed");
    expect(payload.attributes.message).not.toContain("sk-abcdef123456");
    expect(payload.attributes.message).not.toContain("/home/user/secret");
    expect(payload.attributes.message).toContain("boom");
  });

  it("cancel/interrupt/degraded/skipped 各终态语义与 reason 有界", () => {
    const { db } = makeContext();
    // 唯一终态设计：一个 operation 只能有一个终态，故每种终态用独立 operationId
    const cancel = instrument.startLifecycle({
      startEventName: "turn.started", actor: { kind: "user", id: "web" }, executor: { kind: "agent", id: "a" },
      operationId: "op-cancel", terminals: { cancelled: "turn.cancelled" },
    });
    cancel.cancel("aborted");
    const interrupt = instrument.startLifecycle({
      startEventName: "turn.started", actor: { kind: "user", id: "web" }, executor: { kind: "agent", id: "a" },
      operationId: "op-interrupt", terminals: { interrupted: "turn.interrupted" },
    });
    interrupt.interrupt("restart");
    const degraded = instrument.startLifecycle({
      startEventName: "memory.summary.started", actor: { kind: "system", id: "platform" }, executor: { kind: "service", id: "platform" },
      operationId: "op-degraded", terminals: { degraded: "memory.summary.degraded" },
    });
    degraded.degraded("quota");
    const skipped = instrument.startLifecycle({
      startEventName: "tool.call.started", actor: { kind: "user", id: "web" }, executor: { kind: "agent", id: "a" },
      operationId: "op-skipped", terminals: { skipped: "tool.call.denied" },
    });
    skipped.skipped("policy");
    const names = db.prepare("SELECT event_name FROM activity_events WHERE status IN ('cancelled','interrupted','degraded','skipped')").all() as Array<{ event_name: string }>;
    expect(names.map((row) => row.event_name).sort()).toEqual(["memory.summary.degraded", "tool.call.denied", "turn.cancelled", "turn.interrupted"]);
  });
});

describe("T4 Instrument：子系统便捷方法", () => {
  it("boot 生命周期：start/stop 两阶段各自唯一终态，同一 bootId 前缀", () => {
    const { db } = makeContext();
    instrument.systemStarting();
    instrument.systemStarted({ durationMs: 42 });
    instrument.systemStopping();
    instrument.systemStopped();
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'system.started'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'system.stopped'")).toBe(1);
    const boots = db.prepare("SELECT event_name, operation_id FROM activity_events WHERE event_name LIKE 'system.%'").all() as Array<{ event_name: string; operation_id: string }>;
    expect(boots.length).toBe(4);
    // start 阶段（starting/started）与 stop 阶段（stopping/stopped）各一个 operationId
    const byName = new Map(boots.map((row) => [row.event_name, row.operation_id]));
    expect(byName.get("system.starting")).toBe(byName.get("system.started"));
    expect(byName.get("system.stopping")).toBe(byName.get("system.stopped"));
    expect(byName.get("system.started")).not.toBe(byName.get("system.stopped"));
    expect(byName.get("system.started")).toBe("boot-boot-test");
    expect(byName.get("system.stopped")).toBe("boot-boot-test-stop");
  });

  it("storage 迁移事件带 from/to；重复上报幂等", () => {
    const { db } = makeContext();
    instrument.storageDatabaseOpened();
    instrument.storageMigrationCompleted(1, 8);
    instrument.storageMigrationCompleted(1, 8); // 幂等（同 operationId 终态）
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'storage.migration.completed'")).toBe(1);
    const row = db.prepare("SELECT payload_json FROM activity_events WHERE event_name = 'storage.migration.completed'").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).attributes).toEqual({ from: 1, to: 8 });
  });

  it("session 事件归属 ownerAgentId + target session", () => {
    const { db } = makeContext();
    instrument.sessionCreated("session-1", "agent-a");
    instrument.sessionOpened("session-1", "agent-a");
    instrument.sessionArchived("session-1");
    const rows = db.prepare("SELECT event_name, owner_agent_id, session_id, target_kind, target_id FROM activity_events WHERE event_name LIKE 'session.%'").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[0]?.["owner_agent_id"]).toBe("agent-a");
    expect(rows[0]?.["session_id"]).toBe("session-1");
    expect(rows[0]?.["target_kind"]).toBe("session");
    expect(rows[2]?.["owner_agent_id"]).toBeNull(); // 无 agent 时不留归属
  });

  it("provider 凭据变更 → 同库 audit 镜像（不记录 apiKey）", () => {
    const { db } = makeContext();
    instrument.providerCredentialChanged("anthropic");
    instrument.providerConfigured("openai");
    const mirror = db.prepare("SELECT action, decision, payload_json FROM audit_events").all() as Array<{ action: string; decision: string; payload_json: string }>;
    expect(mirror.length).toBe(1);
    expect(mirror[0]?.action).toBe("audit.provider.credential_changed");
    expect(mirror[0]?.decision).toBe("allowed");
    expect(mirror[0]?.payload_json).not.toContain("apiKey");
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'provider.credential.changed'")).toBe(1);
  });

  it("API 失败事件：method/path/status 有界且不含正文", () => {
    const { db } = makeContext();
    instrument.apiRequestFailed("POST", "/api/sessions/x/messages", 500, new Error("upstream 500"));
    instrument.apiValidationFailed("POST", "/api/sessions", "缺少 content");
    const rows = db.prepare("SELECT event_name, payload_json FROM activity_events WHERE event_name LIKE 'api.%'").all() as Array<{ event_name: string; payload_json: string }>;
    expect(rows.length).toBe(2);
    const failed = JSON.parse(rows.find((row) => row.event_name === "api.request.failed")!.payload_json) as { attributes: { method: string; path: string; status: number } };
    expect(failed.attributes).toMatchObject({ method: "POST", path: "/api/sessions/x/messages", status: 500 });
    const validation = JSON.parse(rows.find((row) => row.event_name === "api.validation.failed")!.payload_json) as { attributes: { reason: string } };
    expect(validation.attributes.reason).toBe("缺少 content");
  });

  it("SSE/WS 连接事件 scope 与 clientId", () => {
    const { db } = makeContext();
    instrument.sseConnected("session-1");
    instrument.sseDisconnected("session-1");
    instrument.wsConnected("ws-1");
    instrument.wsDisconnected("ws-1");
    expect(count(db, "SELECT COUNT(*) AS n FROM activity_events WHERE event_name = 'sse.connected' AND session_id = 'session-1'")).toBe(1);
    const ws = db.prepare("SELECT payload_json FROM activity_events WHERE event_name = 'ws.connected'").get() as { payload_json: string };
    expect(JSON.parse(ws.payload_json).attributes).toMatchObject({ clientId: "ws-1" });
  });

  it("supervisor 便捷方法（supervisor 进程身份）", () => {
    const { db } = makeContext();
    instrument.supervisorServerStarted();
    instrument.healthDegraded("Agent Server 进程意外退出");
    instrument.healthRecovered();
    instrument.supervisorServerStopped();
    const names = db.prepare("SELECT event_name FROM activity_events WHERE actor_kind = 'supervisor'").all() as Array<{ event_name: string }>;
    expect(names.map((row) => row.event_name).sort()).toEqual([
      "supervisor.health.degraded",
      "supervisor.health.recovered",
      "supervisor.server.started",
      "supervisor.server.stopped",
    ]);
  });
});
