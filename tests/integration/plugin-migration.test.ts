import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { buildMemorySearchText } from "../../src/storage/memory/cjk-ngram.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";

const temporaryDirectories: string[] = [];

function createHome(): { dir: string; paths: ReturnType<typeof getRuntimePaths> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-plugin-mig-"));
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

describe("Phase 12 migration v10（插件状态表，T1 冻结）", () => {
  it("全新数据库达到 CURRENT_SCHEMA_VERSION 并建立全部插件表", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_%' OR name LIKE 'agent_plugin_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name).sort();
    expect(names).toEqual([
      "agent_plugin_bindings",
      "plugin_configs",
      "plugin_grants",
      "plugin_installations",
      "plugin_operations",
      "plugin_runtime_instances",
      "plugin_source_cache",
    ]);
    db.close();
  });

  it("v9 数据库升级到 v10：保留既有数据且新增插件表", () => {
    const { paths } = createHome();
    // 先构造 v9：新建后把 schema_version 拉回 9，再写入一条会话数据
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.prepare("UPDATE schema_version SET version = 9").run();
    db.prepare(
      "INSERT INTO memory_facts (agent_id, fact, search_text, created_at, updated_at) VALUES ('a1', '旧事实', ?, ?, ?)",
    ).run(buildMemorySearchText("旧事实"), "2026-07-31T00:00:00Z", "2026-07-31T00:00:00Z");
    db.close();

    // 重新打开触发 9 → 10
    const reopened = openMetadataDatabase(paths.database);
    expect(readVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION);
    const fact = reopened.prepare("SELECT fact FROM memory_facts WHERE id = ?").get(1) as { fact: string };
    expect(fact.fact).toBe("旧事实");
    const installs = reopened.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number };
    expect(installs.n).toBe(0);
    reopened.close();
  });

  it("中断恢复幂等：已建插件表但版本未更新时重启不报错", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // 模拟"表已建、schema_version 未更新"的中断状态
    db.prepare("UPDATE schema_version SET version = 9").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_installations (
        plugin_id TEXT NOT NULL, version TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        source_type TEXT NOT NULL, source_ref TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
        artifact_size INTEGER NOT NULL DEFAULT 0, installed_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version)
      );
    `);
    db.close();
    // 重启迁移必须幂等成功（CREATE TABLE IF NOT EXISTS）
    const reopened = openMetadataDatabase(paths.database);
    expect(readVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION);
    reopened.close();
  });

  it("拒绝高于 CURRENT_SCHEMA_VERSION 的数据库", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION + 1);
    db.close();
    expect(() => openMetadataDatabase(paths.database)).toThrow(/不支持的 metadata schema 版本/);
  });
});

describe("Phase 12 插件严格审计（T1 冻结，plans/phase-12.md §17.3）", () => {
  it("migration v10 后 audit_events 保留 event_name/operation_id 列（v9 契约不回归）", () => {
    const { paths } = createHome();
    const db = openMetadataDatabase(paths.database);
    const columns = db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain("event_name");
    expect(names).toContain("operation_id");
    db.close();
  });
});
