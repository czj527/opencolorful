import type Database from "better-sqlite3";

import type { AgentPluginBinding } from "../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Agent 插件绑定存储（plans/phase-12.md §7.3 / §十一）
//
// agent_plugin_bindings：Agent × pluginId 的可见性与允许的 contributions。
// - binding 只引用平台授权（grant_revision），不替代授权；
// - revision 每次绑定变更 +1，配合 grant revision 实现"下一 turn 生效"；
// - 本 Store 只做单行读写，绑定变更的严格审计生命周期由
//   BindingService 负责（本类不自行开启事务，便于放入审计事务）。
// ═══════════════════════════════════════════════════════════════

interface BindingRow {
  agent_id: string;
  plugin_id: string;
  contributions_json: string;
  grant_revision: number;
  enabled: number;
  revision: number;
  updated_at: string;
}

export interface BindingWriteInput {
  readonly agentId: string;
  readonly pluginId: string;
  readonly contributions: readonly string[];
  readonly grantRevision: number;
  readonly enabled: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

function mapRow(row: BindingRow): AgentPluginBinding {
  return {
    agentId: row.agent_id,
    pluginId: row.plugin_id,
    contributions: JSON.parse(row.contributions_json) as string[],
    grantRevision: row.grant_revision,
    enabled: row.enabled === 1,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export class PluginBindingStore {
  constructor(private readonly database: Database.Database) {}

  get(agentId: string, pluginId: string): AgentPluginBinding | null {
    const row = this.database
      .prepare("SELECT * FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?")
      .get(agentId, pluginId) as BindingRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  listByAgent(agentId: string): AgentPluginBinding[] {
    const rows = this.database
      .prepare("SELECT * FROM agent_plugin_bindings WHERE agent_id = ? ORDER BY plugin_id ASC")
      .all(agentId) as BindingRow[];
    return rows.map(mapRow);
  }

  listByPlugin(pluginId: string): AgentPluginBinding[] {
    const rows = this.database
      .prepare("SELECT * FROM agent_plugin_bindings WHERE plugin_id = ? ORDER BY agent_id ASC")
      .all(pluginId) as BindingRow[];
    return rows.map(mapRow);
  }

  /** 绑定修订号（无绑定记录时 0；每次绑定变更 +1） */
  maxRevision(agentId: string, pluginId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?")
      .get(agentId, pluginId) as { revision: number };
    return row.revision;
  }

  upsert(input: BindingWriteInput): void {
    this.database
      .prepare(
        `INSERT INTO agent_plugin_bindings
           (agent_id, plugin_id, contributions_json, grant_revision, enabled, revision, updated_at)
         VALUES (@agentId, @pluginId, @contributionsJson, @grantRevision, @enabled, @revision, @updatedAt)
         ON CONFLICT (agent_id, plugin_id) DO UPDATE SET
           contributions_json = excluded.contributions_json,
           grant_revision = excluded.grant_revision,
           enabled = excluded.enabled,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run({
        agentId: input.agentId,
        pluginId: input.pluginId,
        contributionsJson: JSON.stringify(input.contributions),
        grantRevision: input.grantRevision,
        enabled: input.enabled ? 1 : 0,
        revision: input.revision,
        updatedAt: input.updatedAt,
      });
  }

  remove(agentId: string, pluginId: string): void {
    this.database
      .prepare("DELETE FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?")
      .run(agentId, pluginId);
  }
}
