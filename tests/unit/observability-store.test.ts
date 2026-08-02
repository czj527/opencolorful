import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ActivityEnvelope,
  AuditEnvelope,
  ProducerContext,
} from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ActivityRecorder, type ActivityRecordInput } from "../../src/observability/activity-recorder.js";
import { startOperation } from "../../src/observability/activity-operation.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { EmergencySpool } from "../../src/observability/emergency-spool.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T3：Activity/Audit Store、事务与应急恢复
// 覆盖计划完成条件：SQLite/spool 故障矩阵、同库回滚、文件操作 reconcile、
// spool-only 不广播（导入前不可见）、ledger reset。
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

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function openDb(directory: string) {
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  return db;
}

type ActivityInput = ActivityRecordInput & { operationId: string };
function makeActivityInput(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    eventName: "system.starting",
    payload: { summaryCode: "system_starting" },
    actor: { kind: "system", id: "unit-test" },
    executor: { kind: "service", id: "unit-test" },
    operationId: `op-${Math.random().toString(16).slice(2, 10)}`,
    ...overrides,
  };
}

type AuditInput = Parameters<AuditRecorder["append"]>[0];
function makeAuditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    eventName: "audit.agent.deleted",
    payload: { action: "agent.deleted", decision: "allowed" },
    actor: { kind: "user", id: "tester" },
    ...overrides,
  };
}

/** 合法 activity envelope（用于手工构造 spool 文件行） */
function makeEnvelope(overrides: Partial<ActivityEnvelope> = {}): ActivityEnvelope {
  return {
    schemaVersion: 1,
    eventVersion: 1,
    eventId: `evt-${Math.random().toString(16).slice(2, 10)}`,
    eventName: "system.started",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    level: "info",
    actor: { kind: "system", id: "unit-test" },
    executor: { kind: "service", id: "unit-test" },
    scope: {},
    trace: { traceId: "trace-1", spanId: "span-1" },
    producer,
    channel: "activity",
    significance: "notable",
    payload: { summaryCode: "system_started" },
    ...overrides,
  };
}

function makeAuditEnvelope(overrides: Partial<AuditEnvelope> = {}): AuditEnvelope {
  return {
    schemaVersion: 1,
    eventVersion: 1,
    eventId: `audit-${Math.random().toString(16).slice(2, 10)}`,
    eventName: "audit.agent.deleted",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    level: "warn",
    actor: { kind: "user", id: "tester" },
    executor: { kind: "service", id: "unit-test" },
    scope: {},
    trace: { traceId: "trace-1", spanId: "span-1" },
    producer,
    channel: "audit",
    payload: { action: "agent.deleted", decision: "allowed" },
    ...overrides,
  };
}

function makeContext(directory: string, db = openDb(directory)): { context: ObservabilityContext; db: typeof db } {
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(directory, "logs"),
    spoolRoot: path.join(directory, "spool"),
  });
  return { context, db };
}

afterEach(() => {
  // 先关连接（WAL 锁）再删目录，避免 Windows EPERM
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* 已关闭则忽略 */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T3 ActivityRecorder：durable-on-accept 与故障矩阵", () => {
  it("SQLite 成功 → accepted，权威字段正确落库", () => {
    const directory = makeTempDir("t3-accept-");
    const db = openDb(directory);
    const recorder = new ActivityRecorder({ database: db, producer });
    const result = recorder.append(makeActivityInput({ status: "started" }));
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const row = db.prepare("SELECT * FROM activity_events WHERE event_id = ?").get(result.eventId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["event_name"]).toBe("system.starting");
    expect(row["status"]).toBe("started");
    expect(row["significance"]).toBe("notable"); // 目录冻结，不可覆盖
    expect(row["actor_kind"]).toBe("system");
    expect(row["trace_id"]).toBe("no-trace");
    expect(row["operation_id"]).toBeDefined();
    db.close();
  });

  it("SQLite 故障 → spooled：不落库、可导入、幂等", () => {
    const directory = makeTempDir("t3-spool-");
    const db = openDb(directory);
    const spool = new EmergencySpool({ spoolRoot: path.join(directory, "spool"), processType: producer.processType, bootId: producer.bootId });
    const adapter = { write: (channel: "activity", envelope: ActivityEnvelope) => spool.write(channel, envelope) };
    db.close(); // 关闭连接模拟 SQLite 故障
    const recorder = new ActivityRecorder({ database: db, producer, spool: adapter });
    const result = recorder.append(makeActivityInput());
    expect(result.kind).toBe("spooled");
    expect(spool.pendingSegments()).toBe(1);

    // 导入前：另一连接看不到任何行（spool-only 不广播/不可见）
    const reopened = openDb(directory);
    const countBefore = reopened.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number };
    expect(countBefore.n).toBe(0);

    const importRecorder = new ActivityRecorder({ database: reopened, producer });
    const spoolFiles = fs.readdirSync(path.join(directory, "spool")).filter((name) => name.endsWith(".jsonl"));
    expect(spoolFiles.length).toBe(1);
    const spoolLine = fs.readFileSync(path.join(directory, "spool", spoolFiles[0]!), "utf8").trim();
    const outcome = importRecorder.importEnvelope(JSON.parse(spoolLine));
    expect(outcome.ok).toBe(true);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n).toBe(1);
    // 幂等：同一行再次导入不产生重复
    const again = importRecorder.importEnvelope(JSON.parse(spoolLine));
    expect(again.ok).toBe(true);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n).toBe(1);
    reopened.close();
  });

  it("SQLite 与 spool 双失败 → rejected（不伪装成功）", () => {
    const directory = makeTempDir("t3-doublefail-");
    const db = openDb(directory);
    db.close();
    const failingSpool = { write: () => ({ ok: false, error: "spool 预算已满" }) };
    const recorder = new ActivityRecorder({ database: db, producer, spool: failingSpool });
    const result = recorder.append(makeActivityInput());
    expect(result.kind).toBe("rejected");
    expect(result.kind === "rejected" ? result.reason : "").toContain("spool 预算已满");
  });

  it("无 spool 配置 → SQLite 故障直接 rejected", () => {
    const directory = makeTempDir("t3-nospool-");
    const db = openDb(directory);
    db.close();
    const recorder = new ActivityRecorder({ database: db, producer });
    expect(recorder.append(makeActivityInput()).kind).toBe("rejected");
  });

  it("未注册事件 / 通道错配 / envelope 校验失败 → rejected", () => {
    const directory = makeTempDir("t3-reject-");
    const db = openDb(directory);
    const recorder = new ActivityRecorder({ database: db, producer });
    const unknown = recorder.append(makeActivityInput({ eventName: "totally.unknown" }));
    expect(unknown.kind).toBe("rejected");
    const mismatch = recorder.append(makeActivityInput({ eventName: "audit.agent.deleted" }));
    expect(mismatch.kind).toBe("rejected");
    expect(mismatch.kind === "rejected" ? mismatch.reason : "").toContain("audit");
    const badPayload = recorder.append(makeActivityInput({ payload: { durationMs: 1 } as never })); // 缺 summaryCode
    expect(badPayload.kind).toBe("rejected");
    db.close();
  });
});

describe("T3 唯一终态与 ActivityOperation", () => {
  it("同 operationId 第二次终态 → accepted-idempotent（返回既有 eventId）", () => {
    const directory = makeTempDir("t3-terminal-");
    const db = openDb(directory);
    const recorder = new ActivityRecorder({ database: db, producer });
    const { operation, started } = startOperation(recorder, makeActivityInput());
    expect(started.kind).toBe("accepted");
    const first = operation.complete();
    expect(first.kind).toBe("accepted");
    const second = operation.complete();
    expect(second.kind).toBe("accepted-idempotent");
    if (first.kind === "accepted" && second.kind === "accepted-idempotent") {
      expect(second.eventId).toBe(first.eventId);
    }
    const rows = db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE operation_id = ?").get(operation.operationId) as { n: number };
    expect(rows.n).toBe(2); // started + 唯一终态
    db.close();
  });

  it("fail/cancel/defer 同样满足唯一终态；失败后可继续 append 其他 operation", () => {
    const directory = makeTempDir("t3-opfail-");
    const db = openDb(directory);
    const recorder = new ActivityRecorder({ database: db, producer });
    const { operation } = startOperation(recorder, makeActivityInput());
    expect(operation.fail(new Error("boom")).kind).toBe("accepted");
    expect(operation.complete().kind).toBe("accepted-idempotent");
    const other = startOperation(recorder, makeActivityInput({ operationId: "op-other" }));
    expect(other.started.kind).toBe("accepted");
    db.close();
  });
});

describe("T3 reconcile（文件操作）与 startupRecovery", () => {
  function insertRunningRow(db: ReturnType<typeof openDb>, bootId: string, status: string, recordedAt: string): void {
    db.prepare(
      `INSERT INTO activity_events
        (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
         level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
         trace_id, span_id, producer_component, producer_process_type, boot_id, search_text, payload_json)
       VALUES (?, 1, 1, ?, ?, 'system.starting', 'system', 'info', ?, 'notable',
         'system', 'unit-test', 'service', 'unit-test', 'trace-1', 'span-1', 'unit-test', 'server', ?, '', '{}')`,
    )
      .run(`evt-${Math.random().toString(16).slice(2, 10)}`, recordedAt, recordedAt, status, bootId);
  }

  it("reconcileRunning：旧 boot 遗留 running/processing 补为 interrupted，终态与近期行不动", () => {
    const directory = makeTempDir("t3-reconcile-");
    const db = openDb(directory);
    insertRunningRow(db, "old-boot", "started", "2026-01-01T00:00:00.000Z");
    insertRunningRow(db, "old-boot", "processing", "2026-01-01T00:00:00.000Z");
    insertRunningRow(db, "old-boot", "completed", "2026-01-01T00:00:00.000Z"); // 终态不动
    insertRunningRow(db, "old-boot", "started", "2026-07-01T00:00:00.000Z"); // 近期不动
    insertRunningRow(db, "current-boot", "started", "2026-01-01T00:00:00.000Z"); // 其他 boot 不动
    const recorder = new ActivityRecorder({ database: db, producer });
    const changes = recorder.reconcileRunning("old-boot", "2026-06-01T00:00:00.000Z");
    expect(changes).toBe(2);
    const rows = db.prepare("SELECT status, recorded_at, payload_json FROM activity_events WHERE boot_id = 'old-boot'").all() as Array<{ status: string; recorded_at: string; payload_json: string }>;
    // reconcile 会刷新 recorded_at，按状态集合断言
    expect(rows.map((row) => row.status).sort()).toEqual(["completed", "interrupted", "interrupted", "started"]);
    const interrupted = rows.filter((row) => row.status === "interrupted");
    expect(interrupted.length).toBe(2);
    expect(interrupted[0]?.payload_json).toContain("interrupted_by_restart");
    // 近期行（recorded_at 在窗口后）保持原状态
    expect(rows.find((row) => row.recorded_at === "2026-07-01T00:00:00.000Z")?.status).toBe("started");
    // 其他 boot 不受影响
    const otherBoot = db.prepare("SELECT status FROM activity_events WHERE boot_id = 'current-boot'").get() as { status: string };
    expect(otherBoot.status).toBe("started");
    db.close();
  });

  it("startupRecovery：reconcile 旧 boot + 幂等导入 spool + 记录当前 bootId", () => {
    const directory = makeTempDir("t3-recovery-");
    const { context, db } = makeContext(directory);
    db.prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES ('observability.last_boot_id.server', 'old-boot')").run();
    insertRunningRow(db, "old-boot", "processing", "2026-01-01T00:00:00.000Z");
    // 手工构造 spool 段（上一进程遗留）
    const spoolRoot = path.join(directory, "spool");
    fs.mkdirSync(spoolRoot, { recursive: true });
    const envelope = makeEnvelope({ eventId: "evt-spooled-1" });
    fs.writeFileSync(path.join(spoolRoot, `activity-${producer.processType}-${producer.bootId}-0.jsonl`), `${JSON.stringify(envelope)}\n`, "utf8");

    const result = context.startupRecovery();
    expect(result.interrupted).toBe(1);
    expect(result.spool.imported).toBe(1);
    expect(result.spool.quarantined).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE event_id = 'evt-spooled-1'").get() as { n: number }).n).toBe(1);
    const state = db.prepare("SELECT value FROM observability_state WHERE key = 'observability.last_boot_id.server'").get() as { value: string };
    expect(state.value).toBe(producer.bootId);
    // 再次调用：无新动作（幂等）
    const again = context.startupRecovery();
    expect(again.interrupted).toBe(0);
    expect(again.spool.imported).toBe(0);
    db.close();
  });

  it("spool 坏行 quarantine：原段其余行正常导入", () => {
    const directory = makeTempDir("t3-quarantine-");
    const { context } = makeContext(directory);
    const spoolRoot = path.join(directory, "spool");
    fs.mkdirSync(spoolRoot, { recursive: true });
    const good = makeEnvelope({ eventId: "evt-good" });
    fs.writeFileSync(
      path.join(spoolRoot, `activity-${producer.processType}-${producer.bootId}-0.jsonl`),
      `not-json\n${JSON.stringify(good)}\n{"channel":"activity","eventName":"totally.unknown"}\n`,
      "utf8",
    );
    const result = context.importSpool();
    expect(result.imported).toBe(1);
    expect(result.quarantined).toBe(2);
    expect(result.failed).toBe(0);
    expect(context.getHealth().spool.pendingSegments).toBe(0); // 段已删除
    const quarantineFiles = fs.readdirSync(spoolRoot).filter((name) => name.endsWith(".quarantine"));
    expect(quarantineFiles.length).toBe(1);
  });
});

describe("T3 AuditRecorder：同库回滚与 ledger reset", () => {
  it("runAuditedTransaction 成功：领域修改 + audit 同事务提交", () => {
    const directory = makeTempDir("t3-auditok-");
    const db = openDb(directory);
    const recorder = new AuditRecorder({ database: db, producer });
    const { result, audit } = recorder.runAuditedTransaction(makeAuditInput(), () => {
      db.prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES ('domain.marker', 'committed')").run();
      return 42;
    });
    expect(result).toBe(42);
    expect(audit.kind).toBe("accepted");
    expect((db.prepare("SELECT value FROM observability_state WHERE key = 'domain.marker'").get() as { value: string }).value).toBe("committed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("runAuditedTransaction 审计拒绝 → 领域修改整体回滚", () => {
    const directory = makeTempDir("t3-auditrollback-");
    const db = openDb(directory);
    const recorder = new AuditRecorder({ database: db, producer });
    expect(() =>
      recorder.runAuditedTransaction(makeAuditInput({ eventName: "totally.unknown" }), () => {
        db.prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES ('domain.marker', 'should-rollback')").run();
      }),
    ).toThrow(/审计记录被拒绝/);
    const marker = db.prepare("SELECT value FROM observability_state WHERE key = 'domain.marker'").get() as { value: string } | undefined;
    expect(marker).toBeUndefined(); // 领域修改已回滚
    db.close();
  });

  it("runAuditedTransaction 不 spool：DB 故障直接抛出（fail closed）", () => {
    const directory = makeTempDir("t3-auditclosed-");
    const db = openDb(directory);
    const spool = new EmergencySpool({ spoolRoot: path.join(directory, "spool"), processType: producer.processType, bootId: producer.bootId });
    const adapter = { write: (channel: "audit", envelope: AuditEnvelope) => spool.write(channel, envelope) };
    db.close();
    const recorder = new AuditRecorder({ database: db, producer, spool: adapter });
    expect(() => recorder.runAuditedTransaction(makeAuditInput(), () => 1)).toThrow();
    expect(spool.pendingSegments()).toBe(0); // 绝不脱离事务 spool
  });

  it("独立 append：SQLite 故障 → spooled；导入后 audit 行存在（fail-closed 出口）", () => {
    const directory = makeTempDir("t3-auditspool-");
    const db = openDb(directory);
    const spool = new EmergencySpool({ spoolRoot: path.join(directory, "spool"), processType: producer.processType, bootId: producer.bootId });
    const adapter = { write: (channel: "audit", envelope: AuditEnvelope) => spool.write(channel, envelope) };
    db.close();
    const recorder = new AuditRecorder({ database: db, producer, spool: adapter });
    const result = recorder.append(makeAuditInput());
    expect(result.kind).toBe("spooled");
    expect(spool.pendingSegments()).toBe(1);
    const spoolFiles = fs.readdirSync(path.join(directory, "spool")).filter((name) => name.endsWith(".jsonl"));
    expect(spoolFiles.length).toBe(1);
    const spooledEnvelope = JSON.parse(fs.readFileSync(path.join(directory, "spool", spoolFiles[0]!), "utf8").trim());
    const reopened = openDb(directory);
    const importRecorder = new AuditRecorder({ database: reopened, producer });
    const outcome = importRecorder.importEnvelope(spooledEnvelope);
    expect(outcome.ok).toBe(true);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(1);
    reopened.close();
  });

  it("audit 镜像：activity 事件同事务写 audit_events（责任证据）", () => {
    const directory = makeTempDir("t3-mirror-");
    const db = openDb(directory);
    const recorder = new ActivityRecorder({ database: db, producer });
    const result = recorder.append({
      eventName: "agent.deleted",
      payload: { summaryCode: "agent_deleted", resultRef: "agent-1" },
      actor: { kind: "user", id: "tester" },
      executor: { kind: "service", id: "unit-test" },
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const mirror = db.prepare("SELECT action, decision, ledger_epoch FROM audit_events WHERE event_id = ?").get(`mirror:${result.eventId}`) as { action: string; decision: string; ledger_epoch: number } | undefined;
    expect(mirror).toBeDefined();
    expect(mirror?.action).toBe("audit.agent.deleted");
    expect(mirror?.decision).toBe("allowed");
    expect(mirror?.ledger_epoch).toBe(1);
    db.close();
  });

  it("ledger reset：epoch 递增、旧 epoch 清理、reset 记录（hash 为 NULL）", () => {
    const directory = makeTempDir("t3-ledgerreset-");
    const db = openDb(directory);
    const recorder = new AuditRecorder({ database: db, producer });
    expect(recorder.append(makeAuditInput()).kind).toBe("accepted");
    const reset = recorder.resetLedger({ actor: { kind: "supervisor", id: "admin" }, reason: "轮换", targetCount: 1 });
    expect(reset.newEpoch).toBe(2);
    expect(reset.deleted).toBe(1);
    const rows = db.prepare("SELECT action, decision, ledger_epoch, previous_hash, record_hash FROM audit_events").all() as Array<{ action: string; decision: string; ledger_epoch: number; previous_hash: string | null; record_hash: string | null }>;
    expect(rows.length).toBe(1);
    const first = rows[0]!;
    expect(first.action).toBe("audit.ledger_reset");
    expect(first.decision).toBe("reset");
    expect(first.ledger_epoch).toBe(2);
    expect(first.previous_hash).toBeNull(); // v1 固定 NULL
    expect(first.record_hash).toBeNull();
    // 新记录进入新 epoch
    expect(recorder.append(makeAuditInput()).kind).toBe("accepted");
    expect(recorder.ledgerEpoch()).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE ledger_epoch = 2").get() as { n: number }).n).toBe(2);
    expect(recorder.listByEpoch(2).length).toBe(2);
    expect(recorder.listByEpoch(1).length).toBe(0);
    db.close();
  });
});

describe("T3 ObservabilityContext：health 聚合", () => {
  it("getHealth 聚合 logger/spool/auditEpoch/recovery 状态", () => {
    const directory = makeTempDir("t3-health-");
    const { context } = makeContext(directory);
    const health = context.getHealth();
    expect(health.logger.dropped).toBe(0);
    expect(health.logger.degraded).toBe(false);
    expect(health.spool.failedWrites).toBe(0);
    expect(health.spool.pendingSegments).toBe(0);
    expect(health.auditEpoch).toBe(1);
    expect(health.recovery.lastInterrupted).toBe(0);
    context.logger.info("system.test.health", "health probe");
    context.flush();
  });

  it("startOperation 通过 context 绑定活动 recorder", () => {
    const directory = makeTempDir("t3-ctxop-");
    const { context, db } = makeContext(directory);
    const { operation, started } = context.startOperation(makeActivityInput());
    expect(started.kind).toBe("accepted");
    expect(operation.complete().kind).toBe("accepted");
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n).toBe(2);
    db.close();
  });
});
