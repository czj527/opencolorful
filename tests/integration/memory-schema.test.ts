import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import {
  buildMemoryFtsQuery,
  buildMemorySearchText,
} from "../../src/storage/memory/cjk-ngram.js";

const temporaryDirectories: string[] = [];

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-schema-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  return { paths, database };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function tableNames(database: Database.Database): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function triggerNames(database: Database.Database): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("migration v6（记忆系统底座）", () => {
  it("fresh database reaches CURRENT_SCHEMA_VERSION", () => {
    const { database } = createDatabase();
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  it("creates all Phase 10 tables and FTS virtual tables", () => {
    const { database } = createDatabase();
    const tables = tableNames(database);
    for (const table of [
      "session_summaries",
      "memory_events",
      "memory_events_fts",
      "memory_facts",
      "memory_facts_fts",
      "memory_recalls",
      "memory_recall_episodes",
      "memory_journal",
      "memory_batches",
      "memory_daily_state",
      "memory_watermarks",
      "scheduler_state",
      "memory_recall_events",
      "pinned_memories",
    ]) {
      expect(tables).toContain(table);
    }
    database.close();
  });

  it("creates three-way FTS sync triggers for events and facts", () => {
    const { database } = createDatabase();
    const triggers = triggerNames(database);
    for (const trigger of [
      "memory_events_ai",
      "memory_events_ad",
      "memory_events_au",
      "memory_facts_ai",
      "memory_facts_ad",
      "memory_facts_au",
    ]) {
      expect(triggers).toContain(trigger);
    }
    database.close();
  });

  it("is idempotent: re-running migrations keeps the version without errors", () => {
    const { database } = createDatabase();
    expect(() => applyMigrations(database)).not.toThrow();
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  it("rejects databases from a newer schema", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "metadata.sqlite");
    const raw = new Database(databasePath);
    raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION + 1);
    raw.close();
    expect(() => openMetadataDatabase(databasePath)).toThrow(/不支持的 metadata schema 版本/);
  });

  it("enforces CHECK constraints on memory_facts strengths and statuses", () => {
    const { database } = createDatabase();
    const insert = database.prepare(`
      INSERT INTO memory_facts (agent_id, fact, retention_strength, activation_strength, confidence, status, created_at, updated_at)
      VALUES ('a1', 'f', ?, 0, 0, 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')
    `);
    expect(() => insert.run(101)).toThrow();
    expect(() => insert.run(-1)).toThrow();
    expect(() => insert.run(50)).not.toThrow();

    expect(() =>
      database
        .prepare(
          "INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, created_at) VALUES ('j1', 'a1', 'ghost', 'remember', 'fact', '2026-07-31T00:00:00Z')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          "INSERT INTO memory_batches (id, agent_id, session_id, status, created_at, updated_at) VALUES ('b1', 'a1', 's1', 'mystery', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')",
        )
        .run(),
    ).toThrow();
    database.close();
  });

  it("enforces memory_events source batch uniqueness", () => {
    const { database } = createDatabase();
    const insert = database.prepare(`
      INSERT INTO memory_events (id, agent_id, session_id, branch_revision, source_start_entry, source_end_entry, date, started_at, ended_at, created_at)
      VALUES (?, 'a1', 's1', 'r1', 'e1', 'e9', '2026-07-31', '2026-07-31T00:00:00Z', '2026-07-31T01:00:00Z', '2026-07-31T01:00:00Z')
    `);
    insert.run("ev1");
    expect(() => insert.run("ev2")).toThrow();
    database.close();
  });

  it("keeps memory_facts_fts in sync through insert/update/delete", () => {
    const { database } = createDatabase();
    const searchText = buildMemorySearchText("用户偏好深色模式");
    const inserted = database
      .prepare(
        "INSERT INTO memory_facts (agent_id, fact, search_text, created_at, updated_at) VALUES ('a1', '用户偏好深色模式', ?, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')",
      )
      .run(searchText);
    const factId = Number(inserted.lastInsertRowid);

    const match = database
      .prepare("SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ?")
      .all(buildMemoryFtsQuery("深色模式")) as Array<{ rowid: number }>;
    expect(match.map((row) => row.rowid)).toContain(factId);

    // 换成 n-gram 完全不重叠的内容，验证 update 触发器同步删除旧索引
    database
      .prepare("UPDATE memory_facts SET fact = '用户坚持清淡饮食', search_text = ? WHERE id = ?")
      .run(buildMemorySearchText("用户坚持清淡饮食"), factId);
    const afterUpdate = database
      .prepare("SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ?")
      .all(buildMemoryFtsQuery("深色模式")) as Array<{ rowid: number }>;
    expect(afterUpdate.map((row) => row.rowid)).not.toContain(factId);
    const updatedHit = database
      .prepare("SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ?")
      .all(buildMemoryFtsQuery("清淡饮食")) as Array<{ rowid: number }>;
    expect(updatedHit.map((row) => row.rowid)).toContain(factId);

    database.prepare("DELETE FROM memory_facts WHERE id = ?").run(factId);
    const afterDelete = database
      .prepare("SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ?")
      .all(buildMemoryFtsQuery("清淡饮食")) as Array<{ rowid: number }>;
    expect(afterDelete).toHaveLength(0);
    database.close();
  });

  it("keeps memory_events_fts in sync via rowid triggers and supports CJK queries", () => {
    const { database } = createDatabase();
    database
      .prepare(`
        INSERT INTO memory_events (id, agent_id, session_id, branch_revision, date, started_at, ended_at, summary, topics, search_text, created_at)
        VALUES ('ev1', 'a1', 's1', 'r1', '2026-07-31', '2026-07-31T00:00:00Z', '2026-07-31T01:00:00Z', '讨论了部署方案', '[]', ?, '2026-07-31T01:00:00Z')
      `)
      .run(buildMemorySearchText("讨论了部署方案"));

    const hits = database
      .prepare("SELECT rowid FROM memory_events_fts WHERE memory_events_fts MATCH ?")
      .all(buildMemoryFtsQuery("部署方案")) as Array<{ rowid: number }>;
    expect(hits).toHaveLength(1);

    database.prepare("DELETE FROM memory_events WHERE id = 'ev1'").run();
    const afterDelete = database
      .prepare("SELECT rowid FROM memory_events_fts WHERE memory_events_fts MATCH ?")
      .all(buildMemoryFtsQuery("部署方案")) as Array<{ rowid: number }>;
    expect(afterDelete).toHaveLength(0);
    database.close();
  });

  it("session_summaries isolates branches by composite primary key", () => {
    const { database } = createDatabase();
    const insert = database.prepare(`
      INSERT INTO session_summaries (session_id, branch_revision, agent_id, summary, created_at, updated_at)
      VALUES ('s1', ?, 'a1', '', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')
    `);
    insert.run("rev-a");
    insert.run("rev-b");
    expect(() => insert.run("rev-a")).toThrow();
    const count = database
      .prepare("SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = 's1'")
      .pluck()
      .get() as number;
    expect(count).toBe(2);
    database.close();
  });
});

describe("migration v7（记忆 Agent 审批与优先级）", () => {
  it("fresh database reaches schema version 8 with proposals and observability tables", () => {
    const { database } = createDatabase();
    const version = database
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    const tables = tableNames(database);
    expect(tables).toContain("memory_mutation_proposals");
    expect(tables).toContain("activity_events");
    expect(tables).toContain("audit_events");
    expect(tables).toContain("observability_trace_links");
    expect(tables).toContain("activity_daily_metrics");
    expect(tables).toContain("observability_state");
    const triggers = triggerNames(database);
    expect(triggers).toContain("memory_events_ai");
    expect(triggers).toContain("activity_events_ai");
    database.close();
  });

  it("memory_journal gains priority column defaulting to 0", () => {
    const { database } = createDatabase();
    database
      .prepare(
        "INSERT INTO memory_journal (id, agent_id, actor, intent_type, target_type, created_at) VALUES ('j-p1', 'a1', 'user', 'remember', 'fact', '2026-08-01T00:00:00Z')",
      )
      .run();
    const row = database
      .prepare("SELECT priority FROM memory_journal WHERE id = 'j-p1'")
      .get() as { priority: number };
    expect(row.priority).toBe(0);
    database
      .prepare("UPDATE memory_journal SET priority = 1 WHERE id = 'j-p1'")
      .run();
    const updated = database
      .prepare("SELECT priority FROM memory_journal WHERE id = 'j-p1'")
      .get() as { priority: number };
    expect(updated.priority).toBe(1);
    database.close();
  });

  it("proposal CHECK constraints: type/status/confidence", () => {
    const { database } = createDatabase();
    const insert = database.prepare(`
      INSERT INTO memory_mutation_proposals
        (id, agent_id, run_id, type, payload, evidence_refs, reason, confidence, status, created_at)
      VALUES (?, 'a1', 'r1', ?, '{}', '[]', '', ?, 'pending', '2026-08-01T00:00:00Z')
    `);
    expect(() => insert.run("p1", "create_fact", 0.8)).not.toThrow();
    expect(() => insert.run("p2", "teleport", 0.8)).toThrow();
    expect(() => insert.run("p3", "create_fact", 1.5)).toThrow();
    expect(() =>
      database
        .prepare(
          "UPDATE memory_mutation_proposals SET status = 'mystery' WHERE id = 'p1'",
        )
        .run(),
    ).toThrow();
    database.close();
  });
});

describe("migration v8（Phase 11 可观测性）", () => {
  it("v7 数据库升级到 v8：保留 Phase 10.5 数据且新增可观测性表", () => {
    const { paths, database } = createDatabase();
    // 构造 v7 数据（记忆提案 + 事实）
    const factId = Number(database.prepare(
      "INSERT INTO memory_facts (agent_id, fact, search_text, created_at, updated_at) VALUES ('a1', 'v7 事实', ?, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')",
    ).run(buildMemorySearchText("v7 事实")).lastInsertRowid);
    database.prepare(`
      INSERT INTO memory_mutation_proposals (id, agent_id, run_id, type, payload, evidence_refs, reason, confidence, status, created_at)
      VALUES ('p1', 'a1', 'run-1', 'create_fact', '{"fact":"v7 事实"}', '["session:s1"]', '测试', 0.9, 'applied', '2026-07-31T00:00:00Z')
    `).run();
    // 把 schema_version 拉回 7，模拟 v7 现场升级
    database.prepare("UPDATE schema_version SET version = 7 WHERE version = 8").run();
    database.close();

    // 重新打开 → 触发升级到 v8
    const reopened = openMetadataDatabase(paths.database);
    const version = reopened.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").pluck().get() as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    // Phase 10.5 数据保留
    const fact = reopened.prepare("SELECT fact FROM memory_facts WHERE id = ?").get(factId) as { fact: string };
    expect(fact.fact).toBe("v7 事实");
    const proposal = reopened.prepare("SELECT status FROM memory_mutation_proposals WHERE id = 'p1'").get() as { status: string };
    expect(proposal.status).toBe("applied");
    // 新表存在
    const tables = tableNames(reopened);
    for (const table of ["activity_events", "audit_events", "observability_trace_links", "activity_daily_metrics", "observability_state"]) {
      expect(tables).toContain(table);
    }
    // ledger epoch 默认 1
    const epoch = reopened.prepare("SELECT value FROM observability_state WHERE key = 'audit.ledger_epoch'").pluck().get() as string;
    expect(epoch).toBe("1");
    reopened.close();
  });

  it("activity_events FTS 触发器与主表同步（insert/update/delete）", () => {
    const { database } = createDatabase();
    const now = "2026-08-01T12:00:00.000Z";
    const insert = database.prepare(`
      INSERT INTO activity_events
        (event_id, recorded_at, occurred_at, event_name, category, level, significance,
         actor_kind, actor_id, executor_kind, executor_id, trace_id, span_id,
         producer_component, producer_process_type, boot_id, search_text, payload_json)
      VALUES (?, ?, ?, 'turn.started', 'turn', 'info', 'routine', 'user', 'u1', 'service', 'server', 't1', 's1', 'test', 'server', 'b1', ?, '{}')
    `);
    insert.run("evt-a1", now, now, buildMemorySearchText("用户提问深色模式"));
    const rowId = database.prepare("SELECT id FROM activity_events WHERE event_id = 'evt-a1'").pluck().get() as number;

    const match = database
      .prepare("SELECT rowid FROM activity_events_fts WHERE activity_events_fts MATCH ?")
      .all(buildMemoryFtsQuery("深色模式")) as Array<{ rowid: number }>;
    expect(match.map((r) => r.rowid)).toContain(rowId);

    database.prepare("UPDATE activity_events SET search_text = ? WHERE event_id = 'evt-a1'")
      .run(buildMemorySearchText("用户坚持清淡饮食"));
    const afterUpdate = database
      .prepare("SELECT rowid FROM activity_events_fts WHERE activity_events_fts MATCH ?")
      .all(buildMemoryFtsQuery("深色模式")) as Array<{ rowid: number }>;
    expect(afterUpdate.map((r) => r.rowid)).not.toContain(rowId);

    database.prepare("DELETE FROM activity_events WHERE event_id = 'evt-a1'").run();
    const afterDelete = database
      .prepare("SELECT rowid FROM activity_events_fts WHERE activity_events_fts MATCH ?")
      .all(buildMemoryFtsQuery("清淡饮食")) as Array<{ rowid: number }>;
    expect(afterDelete).toHaveLength(0);
    database.close();
  });
});
