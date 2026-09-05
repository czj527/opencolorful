import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { SessionIndex } from "../../src/storage/session-index.js";

// ═══════════════════════════════════════════════════════════════
// P1 波次B B2：迁移 v15（plans/p1-conversation-workbench.en.md §3.5 决策 5）
// sessions 增加 branch_head_entry_id / branch_head_updated_at /
// source_session_id / source_leaf_entry_id；session_todos 为 B5 的
// durable todo 底座（本次只交付 DDL，单一串行迁移由 B2 独占）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-migration-v15-"));
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

function columnNames(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

/** v14 形状的存量库（schema_version=14 + v14 sessions 表 + 一行存量数据）。 */
function createDatabaseAtV14(directory: string): void {
  const file = pathsFor(directory).database;
  const database = new Database(file);
  database.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (14);

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
    CREATE INDEX sessions_updated_at_idx ON sessions (updated_at DESC);
  `);
  database
    .prepare(
      `INSERT INTO sessions (id, title, session_path, created_at, updated_at, tool_mode, thinking_level)
       VALUES ('legacy-session', '存量会话', '/tmp/legacy.jsonl', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'read-only', 'medium')`,
    )
    .run();
  database.close();
}

describe("metadata schema v15（会话分支元数据 + durable todo 底座）", () => {
  it("fresh database reaches v15 with branch/source columns and session_todos", () => {
    const directory = makeDirectory();
    const database = openMetadataDatabase(pathsFor(directory).database);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(15);

    const sessionColumns = columnNames(database, "sessions");
    for (const column of [
      "branch_head_entry_id",
      "branch_head_updated_at",
      "source_session_id",
      "source_leaf_entry_id",
    ]) {
      expect(sessionColumns).toContain(column);
    }

    expect(columnNames(database, "session_todos")).toEqual([
      "session_id",
      "position",
      "content",
      "status",
      "priority",
      "active_form",
      "updated_at",
    ]);
    database.close();
  });

  it("session_todos enforces status/priority CHECK and composite primary key", () => {
    const directory = makeDirectory();
    const database = openMetadataDatabase(pathsFor(directory).database);
    const insert = database.prepare(
      `INSERT INTO session_todos (session_id, position, content, status, priority, active_form, updated_at)
       VALUES (@sessionId, @position, @content, @status, @priority, @activeForm, @updatedAt)`,
    );
    const base = { sessionId: "s1", position: 0, content: "任务", activeForm: null, updatedAt: "2026-09-05T00:00:00.000Z" };
    insert.run({ ...base, status: "in_progress", priority: "high" });

    // 非法 status / priority 必须被 CHECK 拒绝
    expect(() => insert.run({ ...base, position: 1, status: "done", priority: "high" })).toThrow();
    expect(() => insert.run({ ...base, position: 1, status: "pending", priority: "urgent" })).toThrow();

    // 复合主键 (session_id, position)：同位置覆盖式写入被拒绝
    expect(() => insert.run({ ...base, status: "pending", priority: "low" })).toThrow();
    // 空 active_form 可为 NULL
    insert.run({ ...base, position: 2, content: "第二项", status: "pending", priority: "low" });
    const count = database.prepare("SELECT COUNT(*) FROM session_todos").pluck().get() as number;
    expect(count).toBe(2);
    database.close();
  });

  it("migrates a v14 database with existing session rows without data loss", () => {
    const directory = makeDirectory();
    createDatabaseAtV14(directory);

    const paths = pathsFor(directory);
    const database = openMetadataDatabase(paths.database);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(15);

    // 存量行保留，新列为 NULL（= PI 默认叶子语义 / 非 Fork 会话）
    const row = database
      .prepare(
        "SELECT id, title, branch_head_entry_id, branch_head_updated_at, source_session_id, source_leaf_entry_id FROM sessions WHERE id = 'legacy-session'",
      )
      .get() as {
      id: string;
      title: string;
      branch_head_entry_id: string | null;
      branch_head_updated_at: string | null;
      source_session_id: string | null;
      source_leaf_entry_id: string | null;
    };
    expect(row.id).toBe("legacy-session");
    expect(row.title).toBe("存量会话");
    expect(row.branch_head_entry_id).toBeNull();
    expect(row.branch_head_updated_at).toBeNull();
    expect(row.source_session_id).toBeNull();
    expect(row.source_leaf_entry_id).toBeNull();

    // session_todos 就绪（B5 在其上构建 store/工具）
    expect(columnNames(database, "session_todos")).toContain("status");
    database.close();
  });

  it("SessionIndex maps the new metadata fields and setBranchHead writes both columns", () => {
    const directory = makeDirectory();
    const database = openMetadataDatabase(pathsFor(directory).database);
    const index = new SessionIndex(database);

    const created = index.create({
      id: "meta-session",
      title: "元数据会话",
      sessionPath: "/tmp/meta-session.jsonl",
      sourceSessionId: "source-session",
      sourceLeafEntryId: "leaf-entry-1",
    });
    expect(created.sourceSessionId).toBe("source-session");
    expect(created.sourceLeafEntryId).toBe("leaf-entry-1");
    expect(created.branchHeadEntryId).toBeNull();
    expect(created.branchHeadUpdatedAt).toBeNull();

    const stamped = index.setBranchHead("meta-session", "entry-abc");
    expect(stamped.branchHeadEntryId).toBe("entry-abc");
    expect(stamped.branchHeadUpdatedAt).toBeTypeOf("string");

    // 覆盖写 + 显式清除（null = 回退 PI 默认叶子语义）
    const updated = index.setBranchHead("meta-session", "entry-def");
    expect(updated.branchHeadEntryId).toBe("entry-def");
    const cleared = index.setBranchHead("meta-session", null);
    expect(cleared.branchHeadEntryId).toBeNull();
    expect(cleared.sourceSessionId).toBe("source-session");
    database.close();
  });
});
