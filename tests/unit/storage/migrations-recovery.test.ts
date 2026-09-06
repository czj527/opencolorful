import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../../src/config/paths.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  migrateTo13,
  migrateTo14,
} from "../../../src/storage/migrations.js";

// ═══════════════════════════════════════════════════════════════
// P0-2 审计修复回归：v13/v14 表重建迁移中断后自恢复
// （plans/p1-audit-remediation-migration-recovery.en.md；
//   审计报告 docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md §5 P0-2）
//
// 场景：
//   A   v12 库 + 遗留 memory_journal_v13 → 迁移成功、无临时表残留、版本推进到 15
//   A2  旧代码中断于 DROP 与 RENAME 之间（旧表缺失、仅剩临时表）→ 数据经临时表归位保全
//   B   v13 库 + 遗留 usage_records_v14 → 同 A
//   C   v14 库 + 遗留 session_todos（v15 半成品）→ CREATE TABLE IF NOT EXISTS 幂等吸收
//   D   v13/v14 步骤中途注入故障 → 版本号不变、重建整体回滚（旧 CHECK 复原）、重跑迁移成功
//   E   存量数据保全：恢复路径后 memory_journal / usage_records 存量行完整保留
//
// 降版本注入方式与审计一致：全新库跑完迁移到当前版本 → 回拨 schema_version →
// 手工造遗留表 → 重跑迁移。测试不访问任何真实 Provider 网络，全部使用隔离临时目录。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-migration-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function pathsFor(directory: string) {
  return getRuntimePaths({ OPENCOLORFUL_HOME: directory });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function readVersion(database: Database.Database): number {
  return database
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .pluck()
    .get() as number;
}

function hasTable(database: Database.Database, name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function columnNames(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

/** 全新库跑完迁移到当前版本（作为降版本注入的起点，与审计注入方式一致）。 */
function buildCurrentVersionDatabase(directory: string): void {
  const database = openMetadataDatabase(pathsFor(directory).database);
  expect(readVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  database.close();
}

/** 打开裸连接（绕过 openMetadataDatabase 的迁移），用于降版本与手工造遗留状态。 */
function openRawDatabase(directory: string): Database.Database {
  return new Database(pathsFor(directory).database);
}

function downgradeTo(database: Database.Database, version: number): void {
  database.prepare("UPDATE schema_version SET version = ?").run(version);
}

/** 旧实现（修复前）v13 重建中断后遗留的临时表形状（含遗留诱饵行用的最小列）。 */
const LEGACY_MEMORY_JOURNAL_V13_DDL = `
  CREATE TABLE memory_journal_v13 (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','main_agent','memory_agent','system','background_review')),
    intent_type TEXT NOT NULL CHECK (intent_type IN ('remember','forget','pin','unpin','supersede','merge','suppress','restore')),
    target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session','memory')),
    target_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','rejected','applied','revoked')),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0
  );
`;

/** 旧实现（修复前）v14 重建中断后遗留的临时表形状。 */
const LEGACY_USAGE_RECORDS_V14_DDL = `
  CREATE TABLE usage_records_v14 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    turn_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    context_tokens INTEGER,
    context_window INTEGER,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'main'
      CHECK (source IN ('main','subagent','utility')),
    role TEXT NOT NULL DEFAULT 'primary'
      CHECK (role IN ('primary','secondary')),
    status TEXT NOT NULL DEFAULT 'completed'
      CHECK (status IN ('completed','failed','cancelled','timeout','interrupted','budget_exhausted')),
    agent_id TEXT,
    thread_id TEXT,
    run_id TEXT,
    call_id TEXT,
    started_at TEXT,
    finished_at TEXT,
    dedupe_key TEXT NOT NULL UNIQUE
  );
`;

/**
 * 真实 v12 形状库（schema_version=12 + v12 sessions/memory_journal/v13 形状
 * usage_records），供场景 D 直接驱动单步迁移函数并验证旧 CHECK 的回滚复原。
 */
const V12_DATABASE_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version (version) VALUES (12);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    session_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    provider TEXT,
    model TEXT,
    tool_mode TEXT DEFAULT 'off',
    workspace_cwd TEXT,
    workspace_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_confirmed IN (0, 1)),
    thinking_level TEXT NOT NULL DEFAULT 'medium',
    agent_id TEXT
  );

  CREATE TABLE memory_journal (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','main_agent','memory_agent','system')),
    intent_type TEXT NOT NULL CHECK (intent_type IN ('remember','forget','pin','unpin','supersede','merge','suppress','restore')),
    target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session','memory')),
    target_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','rejected','applied','revoked')),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    context_tokens INTEGER,
    context_window INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, turn_id)
  );
`;

describe("metadata 迁移中断自恢复（P0-2 审计回归）", () => {
  it("场景 A：v12 库 + 遗留 memory_journal_v13 → 迁移成功、无临时表残留、版本推进到 15", () => {
    const directory = makeDirectory();
    buildCurrentVersionDatabase(directory);
    {
      const database = openRawDatabase(directory);
      downgradeTo(database, 12);
      // 旧代码中断遗留：临时表已建好并拷贝了数据（含一条仅存在于遗留表的诱饵行）
      database.exec(LEGACY_MEMORY_JOURNAL_V13_DDL);
      database
        .prepare(
          `INSERT INTO memory_journal_v13 (id, agent_id, actor, intent_type, target_type, payload, status, created_at, priority)
           VALUES ('leftover-only', 'agent-a', 'memory_agent', 'remember', 'fact', '{}', 'pending', '2026-09-01T00:00:00.000Z', 0)`,
        )
        .run();
      database.close();
    }

    // 真实恢复路径：openMetadataDatabase → applyMigrations（修复前在此报
    // "table memory_journal_v13 already exists"，数据库无法打开）
    const recovered = openMetadataDatabase(pathsFor(directory).database);
    expect(readVersion(recovered)).toBe(15);
    expect(hasTable(recovered, "memory_journal_v13")).toBe(false);
    // 遗留临时表被丢弃（以正式表为准重拷），诱饵行不得并入
    const leftoverCount = recovered
      .prepare("SELECT COUNT(*) FROM memory_journal WHERE id = 'leftover-only'")
      .pluck()
      .get() as number;
    expect(leftoverCount).toBe(0);
    // memory_journal 正常可用，且已具备 v13 的 actor 语义
    recovered
      .prepare(
        `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, payload, status, created_at)
         VALUES ('post-recovery', 'agent-a', 'background_review', 'remember', 'fact', '{}', 'pending', '2026-09-02T00:00:00.000Z')`,
      )
      .run();
    recovered.close();
  });

  it("场景 A2：旧代码中断于 DROP 与 RENAME 之间（旧表缺失、数据只在临时表）→ 数据归位保全", () => {
    const directory = makeDirectory();
    buildCurrentVersionDatabase(directory);
    {
      const database = openRawDatabase(directory);
      database
        .prepare(
          `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, payload, status, created_at, applied_at, priority)
           VALUES ('journal-only-copy', 'agent-a', 'user', 'remember', 'fact', '{}', 'applied', '2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z', 2)`,
        )
        .run();
      // 模拟旧代码重建中断后的最终状态：全量拷贝进临时表后旧表被 DROP、尚未 RENAME
      database.exec(LEGACY_MEMORY_JOURNAL_V13_DDL);
      database.exec(
        `INSERT INTO memory_journal_v13
           SELECT id, agent_id, actor, intent_type, target_type, target_id, payload, status, created_at, applied_at, priority
           FROM memory_journal`,
      );
      database.exec("DROP TABLE memory_journal");
      downgradeTo(database, 12);
      database.close();
    }

    const recovered = openMetadataDatabase(pathsFor(directory).database);
    expect(readVersion(recovered)).toBe(15);
    expect(hasTable(recovered, "memory_journal_v13")).toBe(false);
    expect(hasTable(recovered, "memory_journal")).toBe(true);
    const row = recovered
      .prepare("SELECT status, applied_at, priority FROM memory_journal WHERE id = 'journal-only-copy'")
      .get() as { status: string; applied_at: string; priority: number } | undefined;
    expect(row).toEqual({ status: "applied", applied_at: "2026-09-01T01:00:00.000Z", priority: 2 });
    recovered.close();
  });

  it("场景 B：v13 库 + 遗留 usage_records_v14 → 迁移成功、无临时表残留、版本推进到 15", () => {
    const directory = makeDirectory();
    buildCurrentVersionDatabase(directory);
    {
      const database = openRawDatabase(directory);
      downgradeTo(database, 13);
      database.exec(LEGACY_USAGE_RECORDS_V14_DDL);
      database
        .prepare(
          `INSERT INTO usage_records_v14 (session_id, turn_id, provider, model, created_at, dedupe_key)
           VALUES ('leftover-session', 'turn-l', 'faux', 'faux-1', '2026-09-01T00:00:00.000Z', 'leftover:only')`,
        )
        .run();
      database.close();
    }

    const recovered = openMetadataDatabase(pathsFor(directory).database);
    expect(readVersion(recovered)).toBe(15);
    expect(hasTable(recovered, "usage_records_v14")).toBe(false);
    const leftoverCount = recovered
      .prepare("SELECT COUNT(*) FROM usage_records WHERE session_id = 'leftover-session'")
      .pluck()
      .get() as number;
    expect(leftoverCount).toBe(0);
    recovered.close();
  });

  it("场景 C：v14 库 + 遗留 session_todos（v15 半成品）→ 迁移成功且半成品数据保留", () => {
    const directory = makeDirectory();
    buildCurrentVersionDatabase(directory);
    {
      // 降版本后，初次跑到 v15 时创建的 session_todos 即"v15 半成品"遗留
      // （与审计注入方式一致）；预置一行数据验证 IF NOT EXISTS 幂等不丢数据。
      const database = openRawDatabase(directory);
      downgradeTo(database, 14);
      database
        .prepare(
          `INSERT INTO session_todos (session_id, position, content, status, priority, active_form, updated_at)
           VALUES ('s-half', 0, '半成品待办', 'pending', 'low', NULL, '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      database.close();
    }

    const recovered = openMetadataDatabase(pathsFor(directory).database);
    expect(readVersion(recovered)).toBe(15);
    // v15 的 CREATE TABLE IF NOT EXISTS 幂等吸收半成品：不重建、不丢数据
    const todo = recovered
      .prepare("SELECT content, status, priority FROM session_todos WHERE session_id = 's-half'")
      .get() as { content: string; status: string; priority: string } | undefined;
    expect(todo).toEqual({ content: "半成品待办", status: "pending", priority: "low" });
    expect(columnNames(recovered, "session_todos")).toContain("status");
    recovered.close();
  });

  it("场景 D：v13 步骤中途注入故障 → 版本号不变、重建整体回滚、重跑迁移成功", () => {
    const directory = makeDirectory();
    {
      const database = new Database(pathsFor(directory).database);
      database.exec(V12_DATABASE_DDL);
      database
        .prepare(
          `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, payload, status, created_at, priority)
           VALUES ('journal-1', 'agent-a', 'memory_agent', 'remember', 'fact', '{"k":1}', 'applied', '2026-09-01T00:00:00.000Z', 3)`,
        )
        .run();
      database.close();
    }
    const database = openRawDatabase(directory);
    expect(readVersion(database)).toBe(12);

    // 注入方式：migrateTo13 导出的单步函数 + afterRebuild 钩子在重建 SQL 全部
    // 执行后、版本号推进前抛错（最危险中断点：旧表已 DROP/RENAME 完毕）
    expect(() =>
      migrateTo13(database, {
        afterRebuild: () => {
          throw new Error("注入故障：v13 重建 SQL 已执行、版本号未推进");
        },
      }),
    ).toThrow("注入故障");

    // 回滚验证：版本号不变、临时表消失、旧表回到 v12 形状（旧 CHECK 复原）、数据完好
    expect(readVersion(database)).toBe(12);
    expect(hasTable(database, "memory_journal_v13")).toBe(false);
    expect(hasTable(database, "memory_journal")).toBe(true);
    expect(() =>
      database
        .prepare(
          `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, payload, status, created_at)
           VALUES ('probe', 'agent-a', 'background_review', 'remember', 'fact', '{}', 'pending', '2026-09-02T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(); // 旧 CHECK：actor 尚不含 'background_review'，证明回滚到重建前形状
    const preserved = database
      .prepare("SELECT actor, status, priority, payload FROM memory_journal WHERE id = 'journal-1'")
      .get() as { actor: string; status: string; priority: number; payload: string } | undefined;
    expect(preserved).toEqual({ actor: "memory_agent", status: "applied", priority: 3, payload: '{"k":1}' });

    // 重跑迁移（不再注入）：完整走 applyMigrations 恢复到当前版本
    applyMigrations(database);
    expect(readVersion(database)).toBe(15);
    const count = database
      .prepare("SELECT COUNT(*) FROM memory_journal WHERE id = 'journal-1'")
      .pluck()
      .get() as number;
    expect(count).toBe(1);
    database
      .prepare(
        `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, payload, status, created_at)
         VALUES ('journal-post', 'agent-a', 'background_review', 'remember', 'fact', '{}', 'pending', '2026-09-03T00:00:00.000Z')`,
      )
      .run(); // 重建完成后新 CHECK 生效
    database.close();
  });

  it("场景 D（v14 镜像）：v14 步骤中途注入故障 → 版本号不变、重建整体回滚、重跑迁移成功", () => {
    const directory = makeDirectory();
    {
      const database = new Database(pathsFor(directory).database);
      database.exec(V12_DATABASE_DDL);
      database.close();
    }
    const database = openRawDatabase(directory);
    migrateTo13(database); // 先正常完成 v13，再在 v14 注入
    expect(readVersion(database)).toBe(13);
    database
      .prepare(
        `INSERT INTO usage_records (session_id, turn_id, provider, model, input, output, cache_read, cache_write, total_tokens, created_at)
         VALUES ('s-1', 't-1', 'faux', 'faux-1', 100, 50, 10, 5, 165, '2026-09-01T00:00:00.000Z')`,
      )
      .run();

    expect(() =>
      migrateTo14(database, {
        afterRebuild: () => {
          throw new Error("注入故障：v14 重建 SQL 已执行、版本号未推进");
        },
      }),
    ).toThrow("注入故障");

    expect(readVersion(database)).toBe(13);
    expect(hasTable(database, "usage_records_v14")).toBe(false);
    expect(columnNames(database, "usage_records")).not.toContain("source"); // 回到 v13 形状
    const count = database
      .prepare("SELECT COUNT(*) FROM usage_records WHERE session_id = 's-1'")
      .pluck()
      .get() as number;
    expect(count).toBe(1);

    applyMigrations(database);
    expect(readVersion(database)).toBe(15);
    const row = database
      .prepare("SELECT source, role, status, dedupe_key, input, total_tokens FROM usage_records WHERE session_id = 's-1'")
      .get() as {
      source: string;
      role: string;
      status: string;
      dedupe_key: string;
      input: number;
      total_tokens: number;
    };
    expect(row).toEqual({
      source: "main",
      role: "primary",
      status: "completed",
      dedupe_key: "s-1:t-1",
      input: 100,
      total_tokens: 165,
    });
    database.close();
  });

  it("场景 E：恢复路径完整保全 memory_journal / usage_records 存量数据", () => {
    const directory = makeDirectory();
    buildCurrentVersionDatabase(directory);
    {
      const database = openRawDatabase(directory);
      database
        .prepare(
          `INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, target_id, payload, status, created_at, applied_at, priority)
           VALUES ('journal-keep', 'agent-a', 'user', 'forget', 'fact', NULL, '{"reason":"x"}', 'approved', '2026-09-01T08:00:00.000Z', '2026-09-01T09:00:00.000Z', 5)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO usage_records (session_id, turn_id, provider, model, input, output, cache_read, cache_write, total_tokens, context_tokens, context_window, created_at, dedupe_key)
           VALUES ('s-legacy', 't-legacy', 'faux', 'faux-1', 120, 60, 15, 8, 203, 512, 8192, '2026-09-01T10:00:00.000Z', 's-legacy:t-legacy')`,
        )
        .run();
      // 回拨到 v12 + 两类遗留临时表（各带一条诱饵行），触发 A/B 同款恢复路径
      downgradeTo(database, 12);
      database.exec(LEGACY_MEMORY_JOURNAL_V13_DDL);
      database
        .prepare(
          `INSERT INTO memory_journal_v13 (id, agent_id, actor, intent_type, target_type, payload, status, created_at)
           VALUES ('leftover-only', 'agent-a', 'memory_agent', 'remember', 'fact', '{}', 'pending', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      database.exec(LEGACY_USAGE_RECORDS_V14_DDL);
      database
        .prepare(
          `INSERT INTO usage_records_v14 (session_id, turn_id, provider, model, created_at, dedupe_key)
           VALUES ('leftover-session', 'turn-l', 'faux', 'faux-1', '2026-09-01T00:00:00.000Z', 'leftover:only')`,
        )
        .run();
      database.close();
    }

    const recovered = openMetadataDatabase(pathsFor(directory).database);
    expect(readVersion(recovered)).toBe(15);
    expect(hasTable(recovered, "memory_journal_v13")).toBe(false);
    expect(hasTable(recovered, "usage_records_v14")).toBe(false);

    // memory_journal 存量行：11 列逐列保全（经 v13 重建拷贝路径）
    const journal = recovered
      .prepare(
        `SELECT id, agent_id, actor, intent_type, target_type, target_id, payload, status, created_at, applied_at, priority
         FROM memory_journal WHERE id = 'journal-keep'`,
      )
      .get() as {
      id: string;
      agent_id: string;
      actor: string;
      intent_type: string;
      target_type: string;
      target_id: string | null;
      payload: string;
      status: string;
      created_at: string;
      applied_at: string;
      priority: number;
    };
    expect(journal).toEqual({
      id: "journal-keep",
      agent_id: "agent-a",
      actor: "user",
      intent_type: "forget",
      target_type: "fact",
      target_id: null,
      payload: '{"reason":"x"}',
      status: "approved",
      created_at: "2026-09-01T08:00:00.000Z",
      applied_at: "2026-09-01T09:00:00.000Z",
      priority: 5,
    });

    // usage_records 存量行：v13 时代列保全，且按 main/primary/completed 规则回填一致
    const usage = recovered
      .prepare(
        `SELECT id, session_id, turn_id, provider, model, input, output, cache_read, cache_write,
                total_tokens, context_tokens, context_window, created_at, source, role, status, dedupe_key
         FROM usage_records WHERE session_id = 's-legacy'`,
      )
      .get() as {
      id: number;
      session_id: string;
      turn_id: string;
      provider: string;
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      total_tokens: number;
      context_tokens: number;
      context_window: number;
      created_at: string;
      source: string;
      role: string;
      status: string;
      dedupe_key: string;
    };
    expect(usage).toEqual({
      id: 1,
      session_id: "s-legacy",
      turn_id: "t-legacy",
      provider: "faux",
      model: "faux-1",
      input: 120,
      output: 60,
      cache_read: 15,
      cache_write: 8,
      total_tokens: 203,
      context_tokens: 512,
      context_window: 8192,
      created_at: "2026-09-01T10:00:00.000Z",
      source: "main",
      role: "primary",
      status: "completed",
      dedupe_key: "s-legacy:t-legacy",
    });

    // 诱饵行不得并入正式表
    const journalDecoy = recovered
      .prepare("SELECT COUNT(*) FROM memory_journal WHERE id = 'leftover-only'")
      .pluck()
      .get() as number;
    const usageDecoy = recovered
      .prepare("SELECT COUNT(*) FROM usage_records WHERE session_id = 'leftover-session'")
      .pluck()
      .get() as number;
    expect(journalDecoy).toBe(0);
    expect(usageDecoy).toBe(0);
    recovered.close();
  });
});
