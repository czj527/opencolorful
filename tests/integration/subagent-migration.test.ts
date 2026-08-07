import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";

const temporaryDirectories: string[] = [];

function createHome(): { dir: string; paths: ReturnType<typeof getRuntimePaths> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-subagent-mig-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  return { dir, paths };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function readVersion(db: ReturnType<typeof openMetadataDatabase>): number {
  return db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").pluck().get() as number;
}

const SUBAGENT_TABLES = [
  "subagent_artifacts",
  "subagent_messages",
  "subagent_parent_mailbox",
  "subagent_runs",
  "subagent_threads",
  "subagent_workspace_leases",
].sort();

describe("Phase 14 migration v12（Subagent 事实表，T1 冻结）", () => {
  it("全新数据库达到 CURRENT_SCHEMA_VERSION 并建立全部六张 Subagent 表", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'subagent_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(SUBAGENT_TABLES);
    db.close();
  });

  it("v11 数据库升级到 v12：保留 Skill/插件数据且新增 Subagent 表", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // 拉回 v11（保留 v11 表结构与数据），写入一条 Skill 登记记录
    db.prepare("UPDATE schema_version SET version = 11").run();
    db.prepare(
      `INSERT INTO skills (skill_id, source_id, source_kind, version, content_hash, display_name, root_path, manifest_json, validity, trust, readiness, selection, compatibility_level, provenance_json, installed_at, updated_at)
       VALUES ('git-workflow', 'managed', 'managed', '1.0.0', 'sha256-x', 'Git Workflow', '/tmp/skill', '{}', 'valid', 'trusted', 'ready', 'implicit', 'native', '{}', ?, ?)`,
    ).run("2026-08-05T00:00:00Z", "2026-08-05T00:00:00Z");
    // 重新 apply 迁移 → v11 → v12
    applyMigrations(db);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // Skill 数据保留
    const skillRow = db.prepare("SELECT skill_id FROM skills WHERE skill_id = ?").get("git-workflow") as { skill_id: string } | undefined;
    expect(skillRow?.skill_id).toBe("git-workflow");
    // Subagent 表可用（thread → run → message 插入/查询）
    db.prepare(
      `INSERT INTO subagent_threads (thread_id, owner_agent_id, parent_session_id, title, status, model_provider_id, model_id, model_source, thinking_level, workspace_cwd, capability_ceiling_json, context_packet_hash, next_message_sequence, next_run_ordinal, created_at, updated_at, last_activity_at)
       VALUES ('sat_12345678', 'agent-a', 'session-1', '研究', 'open', 'faux', 'faux-1', 'parent_inherited', 'medium', '/tmp', '{}', 'hash-1', 1, 1, ?, ?, ?)`,
    ).run("2026-08-07T00:00:00Z", "2026-08-07T00:00:00Z", "2026-08-07T00:00:00Z");
    db.prepare(
      `INSERT INTO subagent_runs (run_id, thread_id, ordinal, status, trigger_message_id, limits_json, created_at, updated_at)
       VALUES ('sar_12345678', 'sat_12345678', 1, 'queued', 'sam_12345678', '{}', ?, ?)`,
    ).run("2026-08-07T00:00:00Z", "2026-08-07T00:00:00Z");
    const threadRow = db.prepare("SELECT status FROM subagent_threads WHERE thread_id = ?").get("sat_12345678") as { status: string } | undefined;
    expect(threadRow?.status).toBe("open");
    const runRow = db.prepare("SELECT status FROM subagent_runs WHERE run_id = ?").get("sar_12345678") as { status: string } | undefined;
    expect(runRow?.status).toBe("queued");
    db.close();
  });

  it("observability 查询列：activity/audit 都有 subagent_thread_id/subagent_run_id + 索引", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    const activityColumns = db.prepare("PRAGMA table_info(activity_events)").all() as Array<{ name: string }>;
    expect(activityColumns.some((column) => column.name === "subagent_thread_id")).toBe(true);
    expect(activityColumns.some((column) => column.name === "subagent_run_id")).toBe(true);
    const auditColumns = db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
    expect(auditColumns.some((column) => column.name === "subagent_thread_id")).toBe(true);
    expect(auditColumns.some((column) => column.name === "subagent_run_id")).toBe(true);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%subagent%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_activity_subagent_thread",
        "idx_audit_subagent_thread",
        "idx_audit_subagent_run",
        "idx_subagent_threads_owner",
        "idx_subagent_threads_session",
        "idx_subagent_runs_thread",
        "idx_subagent_runs_status",
        "idx_subagent_messages_thread_seq",
        "idx_subagent_messages_run",
        "idx_subagent_artifacts_thread",
        "idx_subagent_mailbox_session",
        "idx_subagent_mailbox_retry",
        "idx_subagent_leases_expiry",
      ]),
    );
    db.close();
  });

  it("拒绝高于当前版本的数据库", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    db.prepare("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION + 1);
    expect(() => applyMigrations(db)).toThrow(/不支持的 metadata schema 版本/);
    db.close();
  });
});
