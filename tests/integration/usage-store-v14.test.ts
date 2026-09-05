import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { UsageStore } from "../../src/storage/usage-store.js";

const temporaryDirectories: string[] = [];

function makeDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-usage-v14-"));
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

interface RawUsageRow {
  session_id: string | null;
  turn_id: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  created_at: string;
  source: string;
  role: string;
  status: string;
  agent_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  call_id: string | null;
  dedupe_key: string;
}

/** v13 存量行形状（迁移前）：只有原始列。 */
type V13Row = Pick<
  RawUsageRow,
  "session_id" | "turn_id" | "provider" | "model" | "input" | "output" | "cache_read" | "cache_write" | "total_tokens" | "created_at"
>;

/** 在 v13 形状上预置存量数据，再交给 applyMigrations 走真实 13→14 迁移路径。 */
function createDatabaseAtV13(directory: string, rows: readonly V13Row[]): void {
  const file = pathsFor(directory).database;
  const database = new Database(file);
  database.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (13);

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
  `);
  const insert = database.prepare(
    `INSERT INTO usage_records
      (session_id, turn_id, provider, model, input, output, cache_read, cache_write, total_tokens, context_tokens, context_window, created_at)
     VALUES (@session_id, @turn_id, @provider, @model, @input, @output, @cache_read, @cache_write, @total_tokens, @context_tokens, @context_window, @created_at)`,
  );
  for (const row of rows) {
    insert.run({ ...row, context_tokens: null, context_window: null });
  }
  database.close();
}

describe("usage schema v14（统一模型用量）", () => {
  it("fresh database reaches CURRENT_SCHEMA_VERSION with v14 columns and indexes", () => {
    const directory = makeDirectory();
    const database = openMetadataDatabase(pathsFor(directory).database);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    // v15 起版本号随串行迁移推进（波次 B2），本测试只锚定"新鲜库 = 当前版本"
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);

    const columns = database.prepare("PRAGMA table_info(usage_records)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    for (const column of ["source", "role", "status", "agent_id", "thread_id", "run_id", "call_id", "started_at", "finished_at", "dedupe_key"]) {
      expect(names).toContain(column);
    }
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((index) => index.name);
    for (const index of ["idx_usage_records_source_time", "idx_usage_records_agent_time", "idx_usage_records_role_time", "idx_usage_records_session_time"]) {
      expect(indexNames).toContain(index);
    }
    database.close();
  });

  it("migrates v13 rows to main/primary/completed with session:turn dedupe keys", () => {
    const directory = makeDirectory();
    createDatabaseAtV13(directory, [
      {
        session_id: "session-1",
        turn_id: "turn-1",
        provider: "faux",
        model: "faux-1",
        input: 100,
        output: 50,
        cache_read: 20,
        cache_write: 10,
        total_tokens: 180,
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        session_id: "session-2",
        turn_id: "turn-2",
        provider: "faux",
        model: "faux-2",
        input: 10,
        output: 5,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 15,
        created_at: "2026-09-02T00:00:00.000Z",
      },
    ]);

    const paths = pathsFor(directory);
    const database = openMetadataDatabase(paths.database);
    applyMigrations(database);
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    const rows = database
      .prepare("SELECT * FROM usage_records ORDER BY session_id")
      .all() as unknown as RawUsageRow[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe("main");
      expect(row.role).toBe("primary");
      expect(row.status).toBe("completed");
      expect(row.agent_id).toBeNull();
      expect(row.dedupe_key).toBe(`${row.session_id}:${row.turn_id}`);
    }
    expect(rows[0]?.total_tokens).toBe(180);
    expect(rows[1]?.total_tokens).toBe(15);
    database.close();
  });

  it("keeps old session totals API semantics while adding calls", () => {
    const directory = makeDirectory();
    createDatabaseAtV13(directory, [
      {
        session_id: "session-1",
        turn_id: "turn-1",
        provider: "faux",
        model: "faux-1",
        input: 100,
        output: 50,
        cache_read: 20,
        cache_write: 10,
        total_tokens: 180,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const database = openMetadataDatabase(pathsFor(directory).database);
    applyMigrations(database);
    const store = new UsageStore(database);

    const totals = store.sessionTotals("session-1");
    expect(totals).toMatchObject({ input: 100, output: 50, totalTokens: 180, turns: 1, calls: 1 });
    expect(store.sessionTotals("missing")).toMatchObject({ turns: 0, calls: 0, input: 0 });
    database.close();
  });
});

describe("usage store v14 record semantics", () => {
  function createStore() {
    const directory = makeDirectory();
    const database = openMetadataDatabase(pathsFor(directory).database);
    return { database, store: new UsageStore(database) };
  }

  it("derives per-source dedupe keys and ignores duplicates", () => {
    const { database, store } = createStore();
    const base = {
      provider: "faux",
      model: "faux-1",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      createdAt: new Date().toISOString(),
    };

    store.record({ ...base, sessionId: "s1", turnId: "t1" });
    store.record({ ...base, sessionId: "s1", turnId: "t1" });
    store.record({ ...base, source: "subagent", sessionId: "s1", threadId: "th1", runId: "r1" });
    store.record({ ...base, source: "subagent", sessionId: "s1", threadId: "th1", runId: "r1" });
    store.record({ ...base, source: "utility", agentId: "a1", callId: "c1" });
    store.record({ ...base, source: "utility", agentId: "a1", callId: "c1" });

    const count = database.prepare("SELECT COUNT(*) AS count FROM usage_records").pluck().get() as number;
    expect(count).toBe(3);

    const rows = database
      .prepare("SELECT source, role, status, session_id, turn_id, agent_id, thread_id, run_id, call_id, dedupe_key FROM usage_records ORDER BY source")
      .all() as Array<{
      source: string;
      role: string;
      status: string;
      session_id: string | null;
      turn_id: string | null;
      agent_id: string | null;
      thread_id: string | null;
      run_id: string | null;
      call_id: string | null;
      dedupe_key: string;
    }>;

    const main = rows.find((row) => row.source === "main");
    expect(main).toMatchObject({ role: "primary", status: "completed", dedupe_key: "s1:t1", session_id: "s1", turn_id: "t1" });
    const subagent = rows.find((row) => row.source === "subagent");
    expect(subagent).toMatchObject({ role: "secondary", status: "completed", dedupe_key: "run:r1", thread_id: "th1", run_id: "r1" });
    const utility = rows.find((row) => row.source === "utility");
    expect(utility).toMatchObject({ role: "secondary", status: "completed", dedupe_key: "call:c1", agent_id: "a1", session_id: null });
    database.close();
  });

  it("summaryFiltered groups by source/role/status and honors filters", () => {
    const { database, store } = createStore();
    const today = new Date().toISOString();
    const base = {
      provider: "faux",
      model: "faux-1",
      createdAt: today,
    };

    store.record({ ...base, sessionId: "s1", turnId: "t1", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 });
    store.record({ ...base, sessionId: "s1", turnId: "t2", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, status: "failed" });
    store.record({ ...base, source: "subagent", sessionId: "s1", threadId: "th1", runId: "r1", input: 20, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 50 });
    store.record({ ...base, source: "utility", agentId: "a1", callId: "c1", input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 });

    const summary = store.summaryFiltered({ days: 30 });
    expect(summary.calls).toBe(4);
    expect(summary.turns).toBe(2);
    expect(summary.sessions).toBe(1);
    expect(summary.totals.totalTokens).toBe(225);

    const bySource = Object.fromEntries(summary.bySource.map((row) => [row.source, row]));
    expect(bySource.main).toMatchObject({ calls: 2, totalTokens: 165 });
    expect(bySource.subagent).toMatchObject({ calls: 1, totalTokens: 50 });
    expect(bySource.utility).toMatchObject({ calls: 1, totalTokens: 10 });

    const byRole = Object.fromEntries(summary.byRole.map((row) => [row.role, row]));
    expect(byRole.primary).toMatchObject({ calls: 2 });
    expect(byRole.secondary).toMatchObject({ calls: 2 });

    const byStatus = Object.fromEntries(summary.byStatus.map((row) => [row.status, row]));
    expect(byStatus.completed).toMatchObject({ calls: 3 });
    expect(byStatus.failed).toMatchObject({ calls: 1 });

    const utilityOnly = store.summaryFiltered({ days: 30, source: "utility" });
    expect(utilityOnly.calls).toBe(1);
    expect(utilityOnly.totals.totalTokens).toBe(10);
    // 全局 utility 调用无会话归属，不计入 sessions
    expect(utilityOnly.sessions).toBe(0);

    const failedOnly = store.summaryFiltered({ days: 30 });
    expect(failedOnly.calls).toBe(4);

    const secondaryOnly = store.summaryFiltered({ days: 30, role: "secondary" });
    expect(secondaryOnly.calls).toBe(2);
    expect(secondaryOnly.totals.totalTokens).toBe(60);
    database.close();
  });

  it("sessionTotals counts subagent rows toward the parent session", () => {
    const { database, store } = createStore();
    const base = {
      provider: "faux",
      model: "faux-1",
      createdAt: new Date().toISOString(),
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
    };
    store.record({ ...base, sessionId: "s1", turnId: "t1" });
    store.record({ ...base, source: "subagent", sessionId: "s1", threadId: "th1", runId: "r1" });

    const totals = store.sessionTotals("s1");
    expect(totals.turns).toBe(1);
    expect(totals.calls).toBe(2);
    expect(totals.totalTokens).toBe(40);
    database.close();
  });
});
