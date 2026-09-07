import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { UsageRecorder, runUtilityCallWithUsage } from "../../src/runtime/usage-recorder.js";
import { createSubagentUsageIngestion } from "../../src/runtime/subagents/runtime/usage-ingestion.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import { UsageSpool } from "../../src/storage/usage-spool.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复回归（§10-2）：usage durable spool / reconciliation。
// 缺陷背景：三处用量摄取点写 usage_records 失败时——utility 吞错、subagent 仅
// instrument.warn、主会话 turn 终态完全无守卫（record 抛错打穿 replayStore 订阅者
// 分发）——账目静默丢失，违背"所有来源用量可查"。
// 修复后：落账失败 → 原始输入入 usage_pending（v16），reconcile 重放回账
// （dedupe 幂等），成功即删；毒行记 attempts 保留、不阻塞队首。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<Database.Database> = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

function createDb(): Database.Database {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-usage-spool-"));
  temporaryDirectories.push(home);
  const database = openMetadataDatabase(path.join(home, "metadata.sqlite"));
  openDatabases.push(database);
  return database;
}

/** record 必抛的 UsageStore 注入（模拟锁竞争/迁移窗口/磁盘抖动下的写库失败） */
function brokenUsageStore(database: Database.Database): UsageStore {
  const store = new UsageStore(database);
  (store as unknown as { record: () => void }).record = () => {
    throw new Error("注入的落账失败（测试内部细节，不得进入用户可见错误）");
  };
  return store;
}

function usageRowCount(database: Database.Database): number {
  return (database.prepare("SELECT COUNT(*) AS count FROM usage_records").get() as { count: number }).count;
}

function pendingRows(database: Database.Database): Array<{ id: number; dedupe_key: string; reason: string; attempts: number }> {
  return database.prepare("SELECT id, dedupe_key, reason, attempts FROM usage_pending ORDER BY id ASC").all() as Array<{ id: number; dedupe_key: string; reason: string; attempts: number }>;
}

function insertPending(database: Database.Database, dedupeKey: string, payload: string): void {
  database
    .prepare("INSERT INTO usage_pending (dedupe_key, payload, reason, attempts, enqueued_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(dedupeKey, payload, "测试注入", "2026-09-07T10:00:00.000Z", "2026-09-07T10:00:00.000Z");
}

function terminalEvent(type: "turn.completed" | "turn.failed", turnId: string, sessionId: string): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `evt-${type}-${turnId}`,
    sessionId,
    streamId: `stream-${turnId}`,
    sequence: 1,
    timestamp: "2026-09-07T10:00:00.000Z",
    type,
    payload: {
      turnId,
      ...(type === "turn.completed"
        ? { usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } }
        : {}),
    },
  };
}

describe("UsageSpool：落账失败入 spool + reconcile 对账回放（P1 审计修复回归）", () => {
  it("三处摄取点经 spool 兜底：record 抛错不丢失账目，恢复后 reconcile 全部回放", async () => {
    const database = createDb();
    const usageStore = new UsageStore(database);
    const brokenStore = brokenUsageStore(database);
    const spool = new UsageSpool({ database, usageStore: brokenStore, retryDelayMs: 0 });

    // ① 主会话 turn 终态（经真实 replayStore 订阅）：修复前 record 抛错会打穿订阅者分发
    const replayStore = new EventReplayStore();
    const recorder = new UsageRecorder(
      replayStore,
      brokenStore,
      () => ({ providerId: "faux", modelId: "faux-1" }),
      () => "agent-spool",
      spool,
    );
    replayStore.publish(terminalEvent("turn.completed", "turn-m1", "sess-m"));
    // EventReplayStore 用 setImmediate 异步通知订阅者，等分发落定
    await new Promise<void>((resolve) => setImmediate(resolve));
    recorder.dispose();

    // ② utility 调用（成功行走 spool；调用结果不受落账失败影响）
    await expect(
      runUtilityCallWithUsage(
        brokenStore,
        { agentId: "agent-spool", sessionId: null, provider: "faux", model: "faux-1", role: "secondary" },
        async () => ({ text: "ok", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 } }),
        spool,
      ),
    ).resolves.toBe("ok");

    // ③ 子代理 Run 终态
    const ingestion = createSubagentUsageIngestion({ usageStore: brokenStore, database, spool });
    expect(() =>
      ingestion({
        status: "succeeded",
        threadId: "sat_spooltest1",
        runId: "sar_spooltest1",
        startedAt: "2026-09-07T09:00:00.000Z",
        finishedAt: "2026-09-07T09:01:00.000Z",
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        ownership: { parentSessionId: "sess-m", ownerAgentId: "agent-spool" },
      } as Parameters<typeof ingestion>[0]),
    ).not.toThrow();

    // 账目没有丢：三行全部在 spool，usage_records 为空
    expect(pendingRows(database)).toHaveLength(3);
    expect(usageRowCount(database)).toBe(0);

    // 恢复：库已可写（健康 store）——按生产接线（start.ts reconcile + enqueue 重试）
    // 用指向同一张 usage_pending/usage_records 表的 spool 执行对账重放
    const recoverySpool = new UsageSpool({ database, usageStore, retryDelayMs: 0 });
    const report = recoverySpool.reconcile();
    expect(report.replayed).toBe(3);
    expect(report.remaining).toBe(0);
    expect(pendingRows(database)).toHaveLength(0);
    expect(usageRowCount(database)).toBe(3);

    const rows = database.prepare("SELECT source, status, total_tokens FROM usage_records ORDER BY id ASC").all() as Array<{ source: string; status: string; total_tokens: number }>;
    expect(rows).toEqual([
      { source: "main", status: "completed", total_tokens: 120 },
      { source: "utility", status: "completed", total_tokens: 6 },
      { source: "subagent", status: "completed", total_tokens: 60 },
    ]);

    // 幂等：重复 reconcile 不产生重复行（spool 已空）
    expect(recoverySpool.reconcile().replayed).toBe(0);
    expect(usageRowCount(database)).toBe(3);
    recoverySpool.dispose();
  });

  it("毒行不阻塞队首：单行持续失败时其余行仍被回放，失败行保留并累计 attempts", () => {
    const database = createDb();
    const usageStore = new UsageStore(database);
    const spool = new UsageSpool({ database, usageStore, retryDelayMs: 0 });

    // 入两行：一行 payload 损坏（JSON 解析失败 = 毒行），一行正常
    insertPending(database, "main:sess-poison:turn-p", "{not-json");
    insertPending(database, "main:sess-good:turn-g1", JSON.stringify({
      sessionId: "sess-good",
      turnId: "turn-g1",
      provider: "faux",
      model: "faux-1",
      input: 7,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      createdAt: "2026-09-07T10:00:01.000Z",
      status: "completed",
    }));

    const report = spool.reconcile();
    expect(report.replayed).toBe(1);
    expect(report.remaining).toBe(1);

    const remaining = pendingRows(database);
    expect(remaining).toHaveLength(1);
    // noUncheckedIndexedAccess：显式收窄后再断言字段
    const poisonRow = remaining[0];
    expect(poisonRow?.dedupe_key).toBe("main:sess-poison:turn-p");
    expect(poisonRow?.attempts).toBe(1);
    expect(usageRowCount(database)).toBe(1);
  });

  it("启动对账：重启后新进程 reconcile 恢复上一进程遗留的 spool 行", () => {
    const database = createDb();
    const usageStore = new UsageStore(database);

    // "上一进程"：落账失败入 spool 后 dispose（模拟进程退出）
    const previousSpool = new UsageSpool({ database, usageStore: brokenUsageStore(database), retryDelayMs: 0 });
    previousSpool.recordWithSpool({
      sessionId: "sess-restart",
      turnId: "turn-r1",
      provider: "faux",
      model: "faux-1",
      input: 30,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 36,
      createdAt: "2026-09-07T10:05:00.000Z",
      status: "completed",
    });
    previousSpool.dispose();
    expect(pendingRows(database)).toHaveLength(1);

    // "当前进程"：新 spool 启动对账恢复遗留行
    const current = new UsageSpool({ database, usageStore, retryDelayMs: 0 });
    const report = current.reconcile();
    expect(report.replayed).toBe(1);
    expect(usageRowCount(database)).toBe(1);
    const row = database.prepare("SELECT source, total_tokens FROM usage_records").get() as { source: string; total_tokens: number };
    expect(row).toEqual({ source: "main", total_tokens: 36 });
    current.dispose();
  });
});
