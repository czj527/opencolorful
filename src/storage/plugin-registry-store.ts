import type Database from "better-sqlite3";

import { PLUGIN_STATUSES, PLUGIN_SOURCE_TYPES, type PluginSourceType, type PluginStatus } from "../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Plugin Registry Store（plans/phase-12.md §7.3）
//
// - plugin_installations 是安装/active version/启用状态事实来源；
// - plugin_operations 记录安装/更新/回滚/卸载/启停操作与补偿状态
//   （started/completed/failed/compensated），供 per-plugin 串行化与
//   中断恢复使用；
// - 同库 Registry 修改 + Audit 的原子性由 Registry 生命周期（installer/
//   registry）用 runAuditedTransaction / appendStrictMany 包裹，本 Store
//   只提供低层单语句方法，不在方法内部开事务。
// ═══════════════════════════════════════════════════════════════

/** plugin_operations.operation CHECK 枚举（与 migration v10 一致） */
export const PLUGIN_OPERATION_KINDS = [
  "install",
  "update",
  "rollback",
  "uninstall",
  "enable",
  "disable",
] as const;
export type PluginOperationKind = (typeof PLUGIN_OPERATION_KINDS)[number];

export const PLUGIN_OPERATION_STATUSES = ["started", "completed", "failed", "compensated"] as const;
export type PluginOperationStatus = (typeof PLUGIN_OPERATION_STATUSES)[number];

export interface PluginInstallationRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly active: boolean;
  readonly status: PluginStatus;
  readonly sourceType: PluginSourceType;
  readonly sourceRef: string;
  readonly sourceVersion: string | null;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly provenance: unknown;
  readonly manifest: unknown;
  readonly installedAt: string;
}

export interface PluginOperationRecord {
  readonly operationId: string;
  readonly pluginId: string;
  readonly operation: PluginOperationKind;
  readonly status: PluginOperationStatus;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly reasonCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface InstallationRow {
  plugin_id: string;
  version: string;
  active: number;
  status: string;
  source_type: string;
  source_ref: string;
  source_version: string | null;
  artifact_sha256: string;
  artifact_size: number;
  provenance_json: string;
  manifest_json: string;
  installed_at: string;
}

interface OperationRow {
  operation_id: string;
  plugin_id: string;
  operation: string;
  status: string;
  from_version: string | null;
  to_version: string | null;
  reason_code: string | null;
  started_at: string;
  finished_at: string | null;
}

function mapInstallationRow(row: InstallationRow | undefined): PluginInstallationRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    pluginId: row.plugin_id,
    version: row.version,
    active: row.active === 1,
    status: row.status as PluginStatus,
    sourceType: row.source_type as PluginSourceType,
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    artifactSha256: row.artifact_sha256,
    artifactSize: row.artifact_size,
    provenance: parseJson(row.provenance_json),
    manifest: parseJson(row.manifest_json),
    installedAt: row.installed_at,
  };
}

function mapOperationRow(row: OperationRow | undefined): PluginOperationRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    operationId: row.operation_id,
    pluginId: row.plugin_id,
    operation: row.operation as PluginOperationKind,
    status: row.status as PluginOperationStatus,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    reasonCode: row.reason_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function assertPluginStatus(status: string): asserts status is PluginStatus {
  if (!(PLUGIN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`不支持的插件状态：${status}`);
  }
}

export class PluginRegistryStore {
  constructor(private readonly database: Database.Database) {}

  // ── plugin_installations ──────────────────────────────────────

  saveInstallation(input: PluginInstallationRecord): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO plugin_installations
          (plugin_id, version, active, status, source_type, source_ref, source_version,
           artifact_sha256, artifact_size, provenance_json, manifest_json, installed_at)
         VALUES (@pluginId, @version, @active, @status, @sourceType, @sourceRef, @sourceVersion,
           @artifactSha256, @artifactSize, @provenanceJson, @manifestJson, @installedAt)`,
      )
      .run({
        pluginId: input.pluginId,
        version: input.version,
        active: input.active ? 1 : 0,
        status: input.status,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        sourceVersion: input.sourceVersion ?? null,
        artifactSha256: input.artifactSha256,
        artifactSize: input.artifactSize,
        provenanceJson: JSON.stringify(input.provenance ?? {}),
        manifestJson: JSON.stringify(input.manifest ?? {}),
        installedAt: input.installedAt,
      });
  }

  getInstallation(pluginId: string, version: string): PluginInstallationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM plugin_installations WHERE plugin_id = ? AND version = ?")
      .get(pluginId, version) as InstallationRow | undefined;
    return mapInstallationRow(row);
  }

  listVersions(pluginId: string): PluginInstallationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_installations WHERE plugin_id = ? ORDER BY installed_at ASC")
      .all(pluginId) as InstallationRow[];
    return rows.map((row) => mapInstallationRow(row) as PluginInstallationRecord);
  }

  listInstalled(): PluginInstallationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_installations ORDER BY plugin_id, installed_at ASC")
      .all() as InstallationRow[];
    return rows.map((row) => mapInstallationRow(row) as PluginInstallationRecord);
  }

  getActive(pluginId: string): PluginInstallationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM plugin_installations WHERE plugin_id = ? AND active = 1")
      .get(pluginId) as InstallationRow | undefined;
    return mapInstallationRow(row);
  }

  /**
   * active 指针原子切换：调用方必须在 Registry 生命周期的事务中调用，
   * 否则两条语句之间不存在原子性。
   */
  setActive(pluginId: string, version: string): void {
    this.database.prepare("UPDATE plugin_installations SET active = 0 WHERE plugin_id = ?").run(pluginId);
    const result = this.database
      .prepare("UPDATE plugin_installations SET active = 1 WHERE plugin_id = ? AND version = ?")
      .run(pluginId, version);
    if (result.changes === 0) {
      throw new Error(`插件版本不存在：${pluginId}@${version}`);
    }
  }

  clearActive(pluginId: string): void {
    this.database.prepare("UPDATE plugin_installations SET active = 0 WHERE plugin_id = ?").run(pluginId);
  }

  setStatus(pluginId: string, version: string, status: PluginStatus): void {
    assertPluginStatus(status);
    this.database
      .prepare("UPDATE plugin_installations SET status = ? WHERE plugin_id = ? AND version = ?")
      .run(status, pluginId, version);
  }

  /** 卸载：全部版本标记 removed 并清除 active（保留 provenance/Audit 事实）。 */
  markRemoved(pluginId: string): void {
    this.database
      .prepare("UPDATE plugin_installations SET status = 'removed', active = 0 WHERE plugin_id = ?")
      .run(pluginId);
  }

  // ── plugin_operations ─────────────────────────────────────────

  startOperation(input: {
    readonly operationId: string;
    readonly pluginId: string;
    readonly operation: PluginOperationKind;
    readonly fromVersion?: string;
    readonly toVersion?: string;
    readonly startedAt?: string;
  }): void {
    const startedAt = input.startedAt ?? new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO plugin_operations
          (operation_id, plugin_id, operation, status, from_version, to_version, started_at)
         VALUES (@operationId, @pluginId, @operation, 'started', @fromVersion, @toVersion, @startedAt)`,
      )
      .run({
        operationId: input.operationId,
        pluginId: input.pluginId,
        operation: input.operation,
        fromVersion: input.fromVersion ?? null,
        toVersion: input.toVersion ?? null,
        startedAt,
      });
  }

  /** 查询指定插件当前仍在进行的操作（中断恢复/冲突检测）。 */
  findStartedOperation(pluginId: string): PluginOperationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM plugin_operations WHERE plugin_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1",
      )
      .get(pluginId) as OperationRow | undefined;
    return mapOperationRow(row);
  }

  /** 全部未终结操作（T10 启动恢复扫描用）。 */
  findOpenOperations(): PluginOperationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_operations WHERE status = 'started' ORDER BY started_at ASC")
      .all() as OperationRow[];
    return rows.map((row) => mapOperationRow(row) as PluginOperationRecord);
  }

  listOperations(pluginId: string): PluginOperationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_operations WHERE plugin_id = ? ORDER BY started_at ASC")
      .all(pluginId) as OperationRow[];
    return rows.map((row) => mapOperationRow(row) as PluginOperationRecord);
  }

  getOperation(operationId: string): PluginOperationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM plugin_operations WHERE operation_id = ?")
      .get(operationId) as OperationRow | undefined;
    return mapOperationRow(row);
  }

  finishOperation(
    operationId: string,
    status: PluginOperationStatus,
    options: { readonly reasonCode?: string; readonly toVersion?: string } = {},
    finishedAt = new Date().toISOString(),
  ): void {
    const sets = ["status = @status", "finished_at = @finishedAt"];
    if (options.reasonCode !== undefined) {
      sets.push("reason_code = @reasonCode");
    }
    if (options.toVersion !== undefined) {
      sets.push("to_version = @toVersion");
    }
    this.database
      .prepare(`UPDATE plugin_operations SET ${sets.join(", ")} WHERE operation_id = @operationId`)
      .run({
        operationId,
        status,
        finishedAt,
        reasonCode: options.reasonCode ?? null,
        toVersion: options.toVersion ?? null,
      });
  }
}
