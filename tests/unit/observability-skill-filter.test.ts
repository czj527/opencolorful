import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ObservabilityQuery } from "../../src/observability/observability-query.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 Observability 查询过滤（plans/phase-13.md §13.2 要求 5）
// - activity：按 payload attributes（skillRefKey/sourceId/bundleRef）过滤；
// - search_text 命中：skillRefKey/sourceId 进 buildSearchText（/logs 全文搜索）；
// - audit：按 before/afterRevision（strict audit 的 refKey）过滤；
// - 既有 pluginId 过滤不回归。
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

function makeDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t7-obs-filter-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  return db;
}

interface SkillEventOverrides {
  readonly eventName?: string;
  readonly attributes?: Record<string, string | number | boolean>;
  readonly pluginId?: string | null;
  readonly recordedAt?: string;
}

function insertSkillEvent(db: ReturnType<typeof openMetadataDatabase>, overrides: SkillEventOverrides = {}): number {
  const id = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM activity_events").get() as { m: number }).m + 1;
  const payloadJson = JSON.stringify({
    summaryCode: (overrides.eventName ?? "skill.discovered").replace(/\./g, "_"),
    attributes: overrides.attributes ?? {},
  });
  db.prepare(
    `INSERT INTO activity_events
      (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
       level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
       plugin_id, trace_id, span_id, parent_span_id, operation_id, duration_ms, error_code,
       producer_component, producer_process_type, boot_id, search_text, payload_json)
     VALUES (?, 1, 1, ?, ?, ?, 'skill', 'info', NULL, 'routine', 'system', 'u', 'service', 'u',
       ?, ?, ?, NULL, ?, NULL, NULL, 'server', 'boot', ?, ?, ?)`,
  )
    .run(
      `evt-skill-${id}`,
      overrides.recordedAt ?? "2026-08-01T00:00:00.000Z",
      overrides.recordedAt ?? "2026-08-01T00:00:00.000Z",
      overrides.eventName ?? "skill.discovered",
      overrides.pluginId ?? null,
      `trace-${id}`,
      `span-${id}`,
      `op-${id}`,
      "boot-skill-test",
      JSON.stringify({ eventName: overrides.eventName ?? "skill.discovered" }),
      payloadJson,
    );
  return id;
}

function insertAuditEvent(
  db: ReturnType<typeof openMetadataDatabase>,
  overrides: { readonly eventName?: string; readonly beforeRevision?: string; readonly afterRevision?: string; readonly targetId?: string | null } = {},
): number {
  const id = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_events").get() as { m: number }).m + 1;
  db.prepare(
    `INSERT INTO audit_events
      (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
       action, decision, event_name, actor_kind, actor_id, executor_kind, executor_id,
       target_kind, target_id, owner_agent_id, session_id, trace_id, operation_id,
       policy_version, before_revision, after_revision, changed_fields_json, payload_json)
     VALUES (?, 1, 1, 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
       'skill.plugin_fix_to_managed', 'allowed', ?, 'user', 'web', 'service', 'skill-plugin-bridge',
       'external_resource', ?, NULL, NULL, ?, ?, '1', ?, ?,
       '["sourceKind","sourceId"]', '{"summaryCode":"skill_install"}')`,
  )
    .run(
      `audit-skill-${id}`,
      overrides.eventName ?? "audit.skill.install_completed",
      overrides.targetId ?? null,
      `trace-audit-${id}`,
      `op-audit-${id}`,
      overrides.beforeRevision ?? null,
      overrides.afterRevision ?? null,
    );
  return id;
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const REF_KEY_A = "demo-skill@plg-1@1.2.0";
const REF_KEY_B = "other-skill@plg-2@0.9.0";

describe("queryActivities skill 过滤", () => {
  it("按 skillRefKey / sourceId / bundleRef 过滤 payload attributes", () => {
    const db = makeDb();
    const query = new ObservabilityQuery(db);
    insertSkillEvent(db, { attributes: { skillRefKey: REF_KEY_A, sourceId: "plg-1", bundleRef: "bundle-a@1.2.0" } });
    insertSkillEvent(db, { attributes: { skillRefKey: REF_KEY_B, sourceId: "plg-2", bundleRef: "bundle-b@0.9.0" } });

    const bySkill = query.queryActivities({ skillRefKey: REF_KEY_A }, null, 50).items;
    expect(bySkill).toHaveLength(1);
    const payload = JSON.parse(bySkill[0]!.payloadJson) as { attributes: Record<string, unknown> };
    expect(payload.attributes["skillRefKey"]).toBe(REF_KEY_A);

    const bySource = query.queryActivities({ sourceId: "plg-2" }, null, 50).items;
    expect(bySource).toHaveLength(1);
    expect(JSON.parse(bySource[0]!.payloadJson) as { attributes: { skillRefKey: string } }).toMatchObject({ attributes: { skillRefKey: REF_KEY_B } });

    const byBundle = query.queryActivities({ bundleRef: "bundle-a@1.2.0" }, null, 50).items;
    expect(byBundle).toHaveLength(1);

    // 组合过滤（skill + source）
    const combined = query.queryActivities({ skillRefKey: REF_KEY_A, sourceId: "plg-2" }, null, 50).items;
    expect(combined).toHaveLength(0);
  });

  it("无 skill 列的普通事件不误中", () => {
    const db = makeDb();
    const query = new ObservabilityQuery(db);
    insertSkillEvent(db, { eventName: "system.started", attributes: {} });
    const bySkill = query.queryActivities({ skillRefKey: REF_KEY_A }, null, 50).items;
    expect(bySkill).toHaveLength(0);
  });

  it("既有 pluginId 过滤不回归（独立列 + 组合使用）", () => {
    const db = makeDb();
    const query = new ObservabilityQuery(db);
    insertSkillEvent(db, { pluginId: "plg-1", attributes: { skillRefKey: REF_KEY_A } });
    insertSkillEvent(db, { pluginId: "plg-9", attributes: { skillRefKey: REF_KEY_A } });

    const byPlugin = query.queryActivities({ pluginId: "plg-1" }, null, 50).items;
    expect(byPlugin).toHaveLength(1);
    const both = query.queryActivities({ pluginId: "plg-1", skillRefKey: REF_KEY_A }, null, 50).items;
    expect(both).toHaveLength(1);
    const mismatch = query.queryActivities({ pluginId: "plg-9", skillRefKey: REF_KEY_B }, null, 50).items;
    expect(mismatch).toHaveLength(0);
  });

  it("search_text 命中：buildSearchText 含 skillRefKey/sourceId（全文搜索可查）", () => {
    const db = makeDb();
    // 经 ActivityRecorder 落库（buildSearchText 生效），再按全文搜索查询
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t7-obs-rec-"));
    temporaryDirectories.push(directory);
    const context = new ObservabilityContext({
      database: db,
      producer,
      logsRoot: path.join(directory, "logs"),
      spoolRoot: path.join(directory, "spool"),
    });
    instrument.init(context);
    instrument.activity({
      eventName: "skill.discovered",
      operationId: "op-search-1",
      actor: { kind: "system", id: "skill-plugin-bridge" },
      executor: { kind: "service", id: "skill-plugin-bridge" },
      payload: { summaryCode: "skill_discovered", attributes: { skillRefKey: REF_KEY_A, sourceId: "plg-1", version: "1.2.0" } },
    });
    const query = new ObservabilityQuery(db);
    // FTS 搜索 refKey（含 @ 与 .，按词切分后 AND 语义；refKey 是连续 token）
    const hits = query.queryActivities({ search: REF_KEY_A }, null, 50).items;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.eventName).toBe("skill.discovered");
    const sourceHits = query.queryActivities({ search: "plg-1" }, null, 50).items;
    expect(sourceHits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("queryAudit skill 过滤", () => {
  it("按 skillRefKey（before/afterRevision/target_id）与 sourceId（refKey LIKE）过滤", () => {
    const db = makeDb();
    const query = new ObservabilityQuery(db);
    insertAuditEvent(db, { beforeRevision: REF_KEY_A, afterRevision: `${REF_KEY_A}->managed` });
    insertAuditEvent(db, { beforeRevision: REF_KEY_B, afterRevision: `${REF_KEY_B}->managed`, targetId: `skill:${REF_KEY_B}` });

    const bySkill = query.queryAudit({ skillRefKey: REF_KEY_A }, null, 50).items;
    expect(bySkill).toHaveLength(1);
    const bySkillTarget = query.queryAudit({ skillRefKey: REF_KEY_B }, null, 50).items;
    expect(bySkillTarget).toHaveLength(1);
    // sourceId 过滤：refKey 的 sourceId 段（skillId@sourceId@version）
    const bySource = query.queryAudit({ sourceId: "plg-1" }, null, 50).items;
    expect(bySource).toHaveLength(1);
    const bySource2 = query.queryAudit({ sourceId: "plg-2" }, null, 50).items;
    expect(bySource2).toHaveLength(1);
    // 不相关行不命中
    insertAuditEvent(db, { beforeRevision: "unrelated", afterRevision: "unrelated" });
    expect(query.queryAudit({ skillRefKey: REF_KEY_A }, null, 50).items).toHaveLength(1);
    // operationId 过滤仍可用
    const byOp = query.queryAudit({ operationId: "op-audit-1" }, null, 50).items;
    expect(byOp).toHaveLength(1);
  });
});
