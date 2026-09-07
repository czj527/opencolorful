import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import { UsageSpool } from "../../src/storage/usage-spool.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复（§10-2）：迁移 v16——usage durable spool 底座。
// usage_pending 表承接三处摄取点落账失败时的原始输入（JSON），等待
// reconcile 对账重放。本测试守护：表结构、v15→v16 升级幂等、
// 与 UsageSpool 端到端（失败入队 → 重放回账）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<Database.Database> = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-migration-v16-"));
  temporaryDirectories.push(directory);
  return directory;
}

function pathsFor(directory: string) {
  return getRuntimePaths({ OPENCOLORFUL_HOME: directory });
}

function openDatabase(directory: string): Database.Database {
  const database = openMetadataDatabase(pathsFor(directory).database);
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try { database.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function columnNames(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe("metadata schema v16（usage durable spool 底座）", () => {
  it("fresh database reaches v16 with usage_pending table", () => {
    const directory = makeDirectory();
    const database = openDatabase(directory);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);

    expect(columnNames(database, "usage_pending")).toEqual([
      "id",
      "dedupe_key",
      "payload",
      "reason",
      "attempts",
      "last_error",
      "enqueued_at",
      "updated_at",
    ]);
  });

  it("reopening the migrated database is idempotent (中断恢复重跑无副作用)", () => {
    const directory = makeDirectory();
    const paths = pathsFor(directory);
    openDatabase(directory).close();
    const database = openDatabase(directory);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(columnNames(database, "usage_pending")).toContain("payload");
  });

  it("end-to-end: enqueue on record failure → reconcile replays back into usage_records", () => {
    const directory = makeDirectory();
    const database = openDatabase(directory);
    const usageStore = new UsageStore(database);

    // record 破损注入（落账必抛）→ recordWithSpool 兜底入行
    const broken = new UsageStore(database);
    (broken as unknown as { record: () => void }).record = () => {
      throw new Error("注入的落账失败");
    };
    const failingSpool = new UsageSpool({ database, usageStore: broken, retryDelayMs: 0 });
    const outcome = failingSpool.recordWithSpool({
      sessionId: "sess-v16",
      turnId: "turn-v16-1",
      provider: "faux",
      model: "faux-1",
      input: 11,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14,
      createdAt: "2026-09-07T11:00:00.000Z",
      status: "completed",
      agentId: "agent-v16",
    });
    expect(outcome).toBe("spooled");
    failingSpool.dispose();

    // 健康侧恢复：reconcile 重放回账，数值与维度逐字段正确
    const recovery = new UsageSpool({ database, usageStore, retryDelayMs: 0 });
    expect(recovery.reconcile()).toEqual({ replayed: 1, remaining: 0 });
    const row = database
      .prepare("SELECT source, status, agent_id, total_tokens FROM usage_records")
      .get() as { source: string; status: string; agent_id: string; total_tokens: number };
    expect(row).toEqual({ source: "main", status: "completed", agent_id: "agent-v16", total_tokens: 14 });
    const pendingCount = (database.prepare("SELECT COUNT(*) AS count FROM usage_pending").get() as { count: number }).count;
    expect(pendingCount).toBe(0);
    recovery.dispose();
  });
});
