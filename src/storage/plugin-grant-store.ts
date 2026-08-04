import type Database from "better-sqlite3";

import type { CapabilityKind, GrantDecision } from "../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 平台级授权存储（plans/phase-12.md §7.3）
//
// plugin_grants：pluginId × capability 的授权结果，revision 单调递增。
// - revision 是插件级单调计数：同一插件的任何能力变更都 +1，
//   Agent binding 引用该 revision 实现"下一 turn 生效"；
// - 本 Store 只做单行读写，授权变更的严格审计生命周期由
//   GrantService 负责（本类不自行开启事务，便于放入审计事务）。
//
// 说明：协议包 PluginGrantSchema 的 Static 类型在 typebox 1.3.6 下对
// `.map()` 构建的 Literal 联合解析为 never（T1 冻结契约缺陷，见
// grant-service.ts 头部说明），本 Store 定义结构一致的 PluginGrantRecord，
// 由 GrantService 以 PluginGrantSchema 运行时校验。
// ═══════════════════════════════════════════════════════════════

/** 平台级授权记录（与 PluginGrantSchema 结构一致） */
export interface PluginGrantRecord {
  readonly pluginId: string;
  readonly capability: CapabilityKind;
  readonly decision: GrantDecision;
  readonly revision: number;
  readonly grantedAt: string;
  /** 授权主体（用户/平台），供 Audit 归责 */
  readonly grantedBy: string;
}

interface GrantRow {
  plugin_id: string;
  capability: string;
  decision: GrantDecision;
  revision: number;
  granted_at: string;
  granted_by: string;
}

export interface GrantWriteInput {
  readonly pluginId: string;
  readonly capability: string;
  readonly decision: GrantDecision;
  readonly revision: number;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

function mapRow(row: GrantRow): PluginGrantRecord {
  return {
    pluginId: row.plugin_id,
    capability: row.capability as CapabilityKind,
    decision: row.decision,
    revision: row.revision,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
  };
}

export class PluginGrantStore {
  constructor(private readonly database: Database.Database) {}

  get(pluginId: string, capability: string): PluginGrantRecord | null {
    const row = this.database
      .prepare("SELECT * FROM plugin_grants WHERE plugin_id = ? AND capability = ?")
      .get(pluginId, capability) as GrantRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  list(pluginId: string): PluginGrantRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_grants WHERE plugin_id = ? ORDER BY capability ASC")
      .all(pluginId) as GrantRow[];
    return rows.map(mapRow);
  }

  listAll(): PluginGrantRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_grants ORDER BY plugin_id ASC, capability ASC")
      .all() as GrantRow[];
    return rows.map(mapRow);
  }

  /** 插件当前授权版本（无授权时 0；>=1 才允许绑定/创建执行快照） */
  maxRevision(pluginId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plugin_grants WHERE plugin_id = ?")
      .get(pluginId) as { revision: number };
    return row.revision;
  }

  upsert(input: GrantWriteInput): void {
    this.database
      .prepare(
        `INSERT INTO plugin_grants (plugin_id, capability, decision, revision, granted_at, granted_by)
         VALUES (@pluginId, @capability, @decision, @revision, @grantedAt, @grantedBy)
         ON CONFLICT (plugin_id, capability) DO UPDATE SET
           decision = excluded.decision,
           revision = excluded.revision,
           granted_at = excluded.granted_at,
           granted_by = excluded.granted_by`,
      )
      .run({
        pluginId: input.pluginId,
        capability: input.capability,
        decision: input.decision,
        revision: input.revision,
        grantedAt: input.grantedAt,
        grantedBy: input.grantedBy,
      });
  }

  remove(pluginId: string, capability: string): void {
    this.database
      .prepare("DELETE FROM plugin_grants WHERE plugin_id = ? AND capability = ?")
      .run(pluginId, capability);
  }

  removeAll(pluginId: string): void {
    this.database
      .prepare("DELETE FROM plugin_grants WHERE plugin_id = ?")
      .run(pluginId);
  }
}
