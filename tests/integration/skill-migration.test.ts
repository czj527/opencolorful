import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";

const temporaryDirectories: string[] = [];

function createHome(): { dir: string; paths: ReturnType<typeof getRuntimePaths> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-skill-mig-"));
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

const SKILL_TABLES = [
  "agent_skill_binding_index",
  "session_skill_bindings",
  "skill_activation_grants",
  "skill_bundle_items",
  "skill_bundles",
  "skill_files",
  "skill_operations",
  "skills",
].sort();

describe("Phase 13 migration v11（Skill 事实表，T1 冻结）", () => {
  it("全新数据库达到 CURRENT_SCHEMA_VERSION 并建立全部 Skill 表", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_%' OR name LIKE 'agent_skill_%' OR name = 'session_skill_bindings' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(SKILL_TABLES);
    db.close();
  });

  it("v10 数据库升级到 v11：保留插件表数据且新增 Skill 表", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // 拉回 v10（保留 v10 表结构与数据），写入一条插件安装记录
    db.prepare("UPDATE schema_version SET version = 10").run();
    db.prepare(
      `INSERT INTO plugin_installations (plugin_id, version, active, status, source_type, source_ref, artifact_sha256, artifact_size, provenance_json, manifest_json, installed_at)
       VALUES ('example.sdk-showcase', '1.0.0', 1, 'enabled', 'local', 'file://fixture', 'abc123', 1, '{}', '{}', ?)`,
    ).run("2026-08-05T00:00:00Z");
    // 重新 apply 迁移 → v10 → v11
    applyMigrations(db);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // 插件数据保留
    const pluginRow = db.prepare("SELECT plugin_id FROM plugin_installations WHERE plugin_id = ?").get("example.sdk-showcase") as
      | { plugin_id: string }
      | undefined;
    expect(pluginRow?.plugin_id).toBe("example.sdk-showcase");
    // Skill 表可用（可插入/查询）
    db.prepare(
      `INSERT INTO skills (skill_id, source_id, source_kind, version, content_hash, display_name, root_path, manifest_json, validity, trust, readiness, selection, compatibility_level, provenance_json, installed_at, updated_at)
       VALUES ('git-workflow', 'managed', 'managed', '1.0.0', 'sha256-x', 'Git Workflow', '/tmp/skill', '{}', 'valid', 'trusted', 'ready', 'implicit', 'native', '{}', ?, ?)`,
    ).run("2026-08-05T00:00:00Z", "2026-08-05T00:00:00Z");
    const skillRow = db.prepare("SELECT skill_id FROM skills WHERE skill_id = ?").get("git-workflow") as { skill_id: string } | undefined;
    expect(skillRow?.skill_id).toBe("git-workflow");
    db.close();
  });

  it("拒绝高于当前版本的数据库（保护契约不被未知未来版本破坏）", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    db.prepare(`UPDATE schema_version SET version = ${CURRENT_SCHEMA_VERSION + 1}`).run();
    expect(() => applyMigrations(db)).toThrow(/不支持的 metadata schema 版本/);
    db.close();
  });
});
