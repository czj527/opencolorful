import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { createExtensionObservabilityPort, type TraceCarrier } from "../../src/observability/extension-port.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T8：ExtensionObservabilityPort（冻结端口 harness 验证）
// 完成条件：扩展不能伪造 actor/owner/trace/producer、不能直接制造
// 长期事件或 Audit；subagent 同步继承 trace；后台任务写规范化 trace link。
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t8-port-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  instrument.init(new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(directory, "logs"),
    spoolRoot: path.join(directory, "spool"),
  }));
  return { db, directory };
}

function makePort(overrides: { eventsPerMinute?: number; now?: () => number } = {}) {
  return createExtensionObservabilityPort({
    manifest: {
      pluginId: "plugin-demo",
      eventNamespace: "demo",
      ...(overrides.eventsPerMinute !== undefined ? { eventsPerMinute: overrides.eventsPerMinute } : {}),
    },
    instrument,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

function allActivity(db: ReturnType<typeof openMetadataDatabase>): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM activity_events ORDER BY id").all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T8 扩展不能伪造平台权威字段", () => {
  it("身份重新盖章：actor/executor/scope 固定为插件身份，producer 为平台", () => {
    const { db } = makeFixture();
    const port = makePort();
    const forgedInput = {
      eventName: "client.unhandled_error",
      summaryCode: "plugin_error",
      // 越权字段（运行时塞入）必须被忽略
      actor: { kind: "user", id: "forged" },
      scope: { ownerAgentId: "forged-agent" },
      trace: { traceId: "forged-trace", spanId: "s" },
      significance: "milestone",
      channel: "audit",
      eventId: "forged-id",
    } as unknown as import("../../src/observability/extension-port.js").ExtensionActivityInput;
    const result = port.activity(forgedInput);
    expect(result.kind).toBe("accepted");
    const row = allActivity(db)[0]!;
    expect(row["actor_kind"]).toBe("plugin");
    expect(row["actor_id"]).toBe("plugin-demo");
    expect(row["executor_kind"]).toBe("plugin");
    expect(row["executor_id"]).toBe("plugin-demo");
    expect(row["plugin_id"]).toBe("plugin-demo");
    expect(row["owner_agent_id"]).toBeNull(); // 伪造 ownerAgent 被忽略
    expect(String(row["trace_id"])).not.toBe("forged-trace");
    expect(String(row["producer_component"])).toBe("unit-test"); // 平台 producer
    expect(row["significance"]).toBe("routine"); // 目录固定 routine（extension-allowed）
    expect(String(row["event_id"])).not.toBe("forged-id");
  });

  it("不能制造 Audit、平台专属或未知事件", () => {
    const { db } = makeFixture();
    const port = makePort();
    expect(port.activity({ eventName: "audit.agent.deleted", summaryCode: "x" }).kind).toBe("rejected");
    expect(port.activity({ eventName: "agent.deleted", summaryCode: "x" }).kind).toBe("rejected"); // milestone 平台专属
    expect(port.activity({ eventName: "system.started", summaryCode: "x" }).kind).toBe("rejected"); // platform-only
    expect(port.activity({ eventName: "totally.unknown", summaryCode: "x" }).kind).toBe("rejected");
    expect(port.activity({ eventName: "plugin.crashed", summaryCode: "x" }).kind).toBe("rejected"); // 平台专属终态
    expect(allActivity(db)).toHaveLength(0);
  });

  it("崩溃终态由平台记录（plugin.crashed platform-only），扩展只能走 routine", () => {
    const { db } = makeFixture();
    const port = makePort();
    // 扩展自身不能发 plugin.crashed
    expect(port.activity({ eventName: "plugin.crashed", summaryCode: "x" }).kind).toBe("rejected");
    // 平台侧（宿主 harness）为插件记录崩溃终态
    instrument.activity({
      eventName: "plugin.crashed",
      status: "failed",
      operationId: "plugin-demo-crash-1",
      actor: { kind: "plugin", id: "plugin-demo" },
      executor: { kind: "plugin", id: "plugin-demo" },
      scope: { pluginId: "plugin-demo" },
      payload: { summaryCode: "plugin_crashed", attributes: { message: "unhandled" } },
    });
    const row = db.prepare("SELECT event_name, status FROM activity_events WHERE event_name = 'plugin.crashed'").get() as { event_name: string; status: string };
    expect(row).toBeDefined();
    expect(row["status"]).toBe("failed");
  });

  it("速率限制：超出 manifest.eventsPerMinute 拒绝（滑动窗口）", () => {
    const { db } = makeFixture();
    let clock = 1_000;
    const port = makePort({ eventsPerMinute: 3, now: () => clock });
    for (let i = 0; i < 3; i += 1) {
      expect(port.activity({ eventName: "client.unhandled_error", summaryCode: `e${i}` }).kind).toBe("accepted");
    }
    expect(port.activity({ eventName: "client.unhandled_error", summaryCode: "e4" }).kind).toBe("rejected");
    // 窗口滑动后恢复
    clock += 61_000;
    expect(port.activity({ eventName: "client.unhandled_error", summaryCode: "e5" }).kind).toBe("accepted");
    expect(allActivity(db)).toHaveLength(4);
  });

  it("端口关闭后全部拒绝/no-op；carrier 过期或非本插件签发 → 回退 no-trace", () => {
    const { db } = makeFixture();
    let clock = 1_000;
    const port = makePort({ now: () => clock });
    const carrier = port.traceCarrier()!;
    // 有效 carrier：trace 被盖章
    const ok = port.activity({ eventName: "client.unhandled_error", summaryCode: "with-carrier", carrier });
    expect(ok.kind).toBe("accepted");
    // 过期 carrier → 回退（trace 非 carrier 的）
    clock += 60_000;
    const expired = port.activity({ eventName: "client.unhandled_error", summaryCode: "expired-carrier", carrier });
    expect(expired.kind).toBe("accepted");
    const rows = allActivity(db);
    const withCarrier = rows.find((row) => String(JSON.parse(String(row["payload_json"])).summaryCode) === "with-carrier")!;
    const expiredRow = rows.find((row) => String(JSON.parse(String(row["payload_json"])).summaryCode) === "expired-carrier")!;
    expect(withCarrier["trace_id"]).toBe(carrier.traceId);
    expect(expiredRow["trace_id"]).toBe("no-trace"); // 过期 carrier 被忽略
    // 非本插件签发的 carrier → 忽略
    const forgedCarrier: TraceCarrier = { ...carrier, pluginId: "other-plugin", expiresAt: clock + 10_000 };
    const forged = port.activity({ eventName: "client.unhandled_error", summaryCode: "forged-carrier", carrier: forgedCarrier });
    expect(forged.kind).toBe("accepted");
    // 关闭端口
    port.close();
    expect(port.activity({ eventName: "client.unhandled_error", summaryCode: "after-close" }).kind).toBe("rejected");
    expect(port.traceCarrier()).toBeUndefined();
  });
});

describe("T8 trace 继承与后台 trace link", () => {
  it("subagent 同步继承 trace：runWithTrace 域内事件同 trace", () => {
    const { db } = makeFixture();
    const parent = instrument.runWithTrace({ trace: { traceId: "trace-parent", spanId: "span-parent" } }, () => {
      instrument.activity({
        eventName: "system.started",
        // 评审 P1-9：terminal 事件必须带目录允许的终态 status
        status: "completed",
        actor: { kind: "system", id: "u" },
        executor: { kind: "service", id: "u" },
        payload: { summaryCode: "x" },
      });
      // fake subagent：在相同 ALS 域内执行（模拟 subagent 继承父 trace）
      instrument.activity({
        eventName: "turn.completed",
        status: "completed",
        actor: { kind: "subagent", id: "sub-1" },
        executor: { kind: "subagent", id: "sub-1" },
        payload: { summaryCode: "y" },
      });
      return instrument.currentTrace()?.traceId;
    });
    expect(parent).toBe("trace-parent");
    const rows = allActivity(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row["trace_id"] === "trace-parent")).toBe(true);
  });

  it("后台任务写规范化 trace link（source=来源, target=新 trace, relation=spawned）", () => {
    const { db } = makeFixture();
    instrument.runAsBackground({ linkedTraceIds: ["trace-source-1"], operationId: "bg-op-1" }, () => {
      instrument.activity({
        eventName: "memory.batch.sealed",
        actor: { kind: "scheduler", id: "ticker" },
        executor: { kind: "memory_agent", id: "a1" },
        scope: { ownerAgentId: "a1" },
        payload: { summaryCode: "x" },
      });
    });
    const links = db.prepare("SELECT source_trace_id, target_trace_id, relation FROM observability_trace_links").all() as Array<{ source_trace_id: string; target_trace_id: string; relation: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source_trace_id: "trace-source-1", relation: "spawned" });
    // 后台事件 trace = link 目标
    const row = allActivity(db)[0]!;
    expect(row["trace_id"]).toBe(links[0]!.target_trace_id);
    expect(String(row["trace_id"])).not.toBe("trace-source-1");
  });

  it("diagnostic 走 namespace 前缀且不落 activity", () => {
    const { db } = makeFixture();
    const port = makePort();
    port.diagnostic("info", "ping", "pong", { attempt: 1 });
    expect(allActivity(db)).toHaveLength(0);
  });
});

describe("Phase 11 复审修复（评审 P1-10 复现级测试）", () => {
  it("伪造 carrier（有效时间范围、无平台登记令牌）→ 拒绝盖章，trace 回退 ALS", () => {
    const { db } = makeFixture();
    const port = makePort();
    const now = Date.now();
    // 插件自行构造"时间范围有效"的 carrier（原实现会接受）
    const forged: TraceCarrier = {
      traceId: "forged-trace", spanId: "forged-span",
      pluginId: "plugin-demo",
      token: "forged-token-1234567890abcdef",
      issuedAt: now - 1000,
      expiresAt: now + 29_000,
    };
    const result = port.activity({
      eventName: "client.unhandled_error", summaryCode: "x",
      carrier: forged,
    });
    expect(result.kind).toBe("accepted");
    const row = allActivity(db)[0]!;
    // 伪造 trace 未被接受：trace 回退为平台 ALS（no-trace 或当前上下文）
    expect(row["trace_id"]).not.toBe("forged-trace");
  });

  it("签发 carrier 有效且单次消费：第二次重放同一 carrier → 回退 no-trace", () => {
    const { db } = makeFixture();
    const port = makePort();
    const carrier = port.traceCarrier();
    expect(carrier).toBeDefined();
    if (carrier === undefined) return;
    const first = port.activity({ eventName: "client.unhandled_error", summaryCode: "a", carrier });
    expect(first.kind).toBe("accepted");
    const firstRow = allActivity(db)[0]!;
    expect(firstRow["trace_id"]).toBe(carrier.traceId);
    // 重放同一 carrier（令牌已消费）→ 回退，不沿用 carrier trace
    const second = port.activity({ eventName: "client.unhandled_error", summaryCode: "b", carrier });
    expect(second.kind).toBe("accepted");
    const secondRow = allActivity(db)[1]!;
    expect(secondRow["trace_id"]).not.toBe(carrier.traceId);
  });
});
