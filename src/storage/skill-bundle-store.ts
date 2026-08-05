import type Database from "better-sqlite3";

import type { SkillSelectionMode, SkillSourceKind } from "../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Skill Bundle 存储（plans/phase-13.md §9.3 / §9.1）
//
// skill_bundles + skill_bundle_items：版本化 SkillRef 集合的事实来源。
// - Bundle 变更必须创建新版本（版本自增，不原地覆盖旧版本，旧版本可回滚）；
// - contentHash 由 items+name+source 计算（SkillBundleService 负责），
//   本 Store 只做持久化，不计算、不篡改；
// - 一个版本 = skill_bundles 一行 + skill_bundle_items 多行，insertBundleVersion
//   在同一 SQLite 事务内写入（版本组合不可拆分为半完成状态）；
// - 领域写入与审计的原子性由上层 Service 生命周期负责（本类不自行开事务）。
// ═══════════════════════════════════════════════════════════════

/** Bundle 版本项：精确 skillRefKey（skillId@sourceId@version）+ 该 Agent 侧选择覆盖。 */
export interface BundleItemRecord {
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly ordinal: number;
}

/** Bundle 版本完整快照（含按 ordinal 排序的 items）。 */
export interface BundleVersionRecord {
  readonly bundleId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly name: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourceId: string;
  readonly manifestJson: string;
  readonly createdAt: string;
  readonly supersedesVersion: string | null;
  readonly items: readonly BundleItemRecord[];
}

interface BundleRow {
  bundle_id: string;
  version: string;
  content_hash: string;
  name: string;
  source_kind: string;
  source_id: string;
  manifest_json: string;
  created_at: string;
  supersedes_version: string | null;
}

interface ItemRow {
  bundle_id: string;
  bundle_version: string;
  skill_ref_key: string;
  selection: string;
  ordinal: number;
}

function mapBundle(row: BundleRow, items: readonly BundleItemRecord[]): BundleVersionRecord {
  return {
    bundleId: row.bundle_id,
    version: row.version,
    contentHash: row.content_hash,
    name: row.name,
    sourceKind: row.source_kind as SkillSourceKind,
    sourceId: row.source_id,
    manifestJson: row.manifest_json,
    createdAt: row.created_at,
    supersedesVersion: row.supersedes_version,
    items,
  };
}

function mapItem(row: ItemRow): BundleItemRecord {
  return {
    bundleId: row.bundle_id,
    bundleVersion: row.bundle_version,
    skillRefKey: row.skill_ref_key,
    selection: row.selection as SkillSelectionMode,
    ordinal: row.ordinal,
  };
}

export class SkillBundleStore {
  constructor(private readonly database: Database.Database) {}

  /** 版本组合原子写入：bundle 行 + items 行同一事务（版本化不可分割）。 */
  insertBundleVersion(input: {
    readonly bundleId: string;
    readonly version: string;
    readonly contentHash: string;
    readonly name: string;
    readonly sourceKind: SkillSourceKind;
    readonly sourceId: string;
    readonly manifestJson?: string;
    readonly createdAt: string;
    readonly supersedesVersion?: string;
    readonly items: readonly {
      readonly skillRefKey: string;
      readonly selection: SkillSelectionMode;
      readonly ordinal: number;
    }[];
  }): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO skill_bundles
            (bundle_id, version, content_hash, name, source_kind, source_id, manifest_json, created_at, supersedes_version)
           VALUES (@bundleId, @version, @contentHash, @name, @sourceKind, @sourceId, @manifestJson, @createdAt, @supersedesVersion)`,
        )
        .run({
          bundleId: input.bundleId,
          version: input.version,
          contentHash: input.contentHash,
          name: input.name,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          manifestJson: input.manifestJson ?? "{}",
          createdAt: input.createdAt,
          supersedesVersion: input.supersedesVersion ?? null,
        });
      const insertItem = this.database.prepare(
        `INSERT INTO skill_bundle_items
          (bundle_id, bundle_version, skill_ref_key, selection, ordinal)
         VALUES (@bundleId, @bundleVersion, @skillRefKey, @selection, @ordinal)`,
      );
      for (const item of input.items) {
        insertItem.run({
          bundleId: input.bundleId,
          bundleVersion: input.version,
          skillRefKey: item.skillRefKey,
          selection: item.selection,
          ordinal: item.ordinal,
        });
      }
    })();
  }

  getBundle(bundleId: string, version: string): BundleVersionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM skill_bundles WHERE bundle_id = ? AND version = ?")
      .get(bundleId, version) as BundleRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapBundle(row, this.listItems(bundleId, version));
  }

  /** 某 Bundle 全部版本（含 items，按版本号降序）。 */
  listVersions(bundleId: string): BundleVersionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM skill_bundles WHERE bundle_id = ? ORDER BY version DESC")
      .all(bundleId) as BundleRow[];
    return rows.map((row) => mapBundle(row, this.listItems(bundleId, row.version)));
  }

  /** 某 Bundle 最新版本（版本号字符串降序第一个）。 */
  latestVersion(bundleId: string): BundleVersionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM skill_bundles WHERE bundle_id = ? ORDER BY version DESC LIMIT 1")
      .get(bundleId) as BundleRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapBundle(row, this.listItems(bundleId, row.version));
  }

  /** 下一个版本号：已有版本解析为数字的最大值 + 1；无版本时从 "1" 开始。 */
  nextVersion(bundleId: string): string {
    const rows = this.database
      .prepare("SELECT version FROM skill_bundles WHERE bundle_id = ?")
      .all(bundleId) as Array<{ version: string }>;
    let max = 0;
    for (const row of rows) {
      const parsed = Number.parseInt(row.version, 10);
      if (Number.isFinite(parsed) && parsed > max) {
        max = parsed;
      }
    }
    return String(max + 1);
  }

  /** 全部 Bundle 的版本摘要（无 items；管理页列表用）。 */
  listBundles(): Array<{
    readonly bundleId: string;
    readonly version: string;
    readonly contentHash: string;
    readonly name: string;
    readonly sourceKind: SkillSourceKind;
    readonly sourceId: string;
    readonly createdAt: string;
  }> {
    const rows = this.database
      .prepare("SELECT * FROM skill_bundles ORDER BY bundle_id ASC, version DESC")
      .all() as BundleRow[];
    return rows.map((row) => ({
      bundleId: row.bundle_id,
      version: row.version,
      contentHash: row.content_hash,
      name: row.name,
      sourceKind: row.source_kind as SkillSourceKind,
      sourceId: row.source_id,
      createdAt: row.created_at,
    }));
  }

  private listItems(bundleId: string, version: string): BundleItemRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM skill_bundle_items WHERE bundle_id = ? AND bundle_version = ? ORDER BY ordinal ASC, skill_ref_key ASC",
      )
      .all(bundleId, version) as ItemRow[];
    return rows.map(mapItem);
  }
}

