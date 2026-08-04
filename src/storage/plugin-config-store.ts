import type Database from "better-sqlite3";

// ═══════════════════════════════════════════════════════════════
// Phase 12 插件配置存储（plans/phase-12.md §7.3）
//
// plugin_configs：全局（agent_id = ''）与 per-Agent 非敏感配置。
// - config_json 只存非敏感值；Secret 走 PluginSecretStore（T1 范围外）；
// - revision 按 (plugin_id, agent_id) 单调递增，配置变更"下一 turn 生效"；
// - 配置变更的严格审计生命周期（audit.plugin.config_change_*）由
//   T5 的 Config contribution 接入，本 Store 只提供原子读写与版本计数。
// ═══════════════════════════════════════════════════════════════

interface ConfigRow {
  plugin_id: string;
  agent_id: string;
  revision: number;
  config_json: string;
  updated_at: string;
}

export interface PluginConfigEntry {
  readonly pluginId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly config: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface ConfigWriteInput {
  readonly pluginId: string;
  readonly agentId: string;
  readonly config: Record<string, unknown>;
  readonly updatedAt: string;
}

function mapRow(row: ConfigRow): PluginConfigEntry {
  return {
    pluginId: row.plugin_id,
    agentId: row.agent_id,
    revision: row.revision,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
}

export class PluginConfigStore {
  constructor(private readonly database: Database.Database) {}

  get(pluginId: string, agentId: string): PluginConfigEntry | null {
    const row = this.database
      .prepare("SELECT * FROM plugin_configs WHERE plugin_id = ? AND agent_id = ?")
      .get(pluginId, agentId) as ConfigRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  list(pluginId: string): PluginConfigEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_configs WHERE plugin_id = ? ORDER BY agent_id ASC")
      .all(pluginId) as ConfigRow[];
    return rows.map(mapRow);
  }

  listAll(): PluginConfigEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM plugin_configs ORDER BY plugin_id ASC, agent_id ASC")
      .all() as ConfigRow[];
    return rows.map(mapRow);
  }

  /** 配置修订号（无记录时 0；每次写入 +1，原子计算） */
  maxRevision(pluginId: string, agentId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plugin_configs WHERE plugin_id = ? AND agent_id = ?")
      .get(pluginId, agentId) as { revision: number };
    return row.revision;
  }

  /** 原子写入：修订号在事务内单调 +1（外部审计事务可复用同一连接嵌套） */
  set(input: ConfigWriteInput): { revision: number } {
    const write = this.database.transaction((): { revision: number } => {
      const revision = this.maxRevision(input.pluginId, input.agentId) + 1;
      this.database
        .prepare(
          `INSERT INTO plugin_configs (plugin_id, agent_id, revision, config_json, updated_at)
           VALUES (@pluginId, @agentId, @revision, @configJson, @updatedAt)
           ON CONFLICT (plugin_id, agent_id) DO UPDATE SET
             revision = excluded.revision,
             config_json = excluded.config_json,
             updated_at = excluded.updated_at`,
        )
        .run({
          pluginId: input.pluginId,
          agentId: input.agentId,
          revision,
          configJson: JSON.stringify(input.config),
          updatedAt: input.updatedAt,
        });
      return { revision };
    });
    return write();
  }

  remove(pluginId: string, agentId: string): void {
    this.database
      .prepare("DELETE FROM plugin_configs WHERE plugin_id = ? AND agent_id = ?")
      .run(pluginId, agentId);
  }

  removeAll(pluginId: string): void {
    this.database
      .prepare("DELETE FROM plugin_configs WHERE plugin_id = ?")
      .run(pluginId);
  }
}
