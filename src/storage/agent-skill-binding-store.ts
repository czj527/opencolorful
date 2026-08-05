import type Database from "better-sqlite3";

import type { SkillSelectionMode } from "../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Agent Skill 绑定投影（plans/phase-13.md §9.1）
//
// agent_skill_binding_index：**查询投影**，可从 agents/<agentId>/skills.json
// 重建（skills.json 是 Agent 持久绑定的唯一事实来源）。本 Store：
// - 只做整 Agent 重建（rebuild）/ 读取，不做单条业务写入（业务写入走
//   skills.json + 严格审计生命周期，随后 rebuild 本投影）；
// - rebuild 在同一事务内 DELETE + INSERT，保证投影与 skills.json 一致；
// - configRevision 由 Service 传入（skills.json 每次绑定变更 +1），
//   配合"下一 turn 生效"语义。
// ═══════════════════════════════════════════════════════════════

export interface AgentSkillBindingRow {
  readonly agentId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly bundleId: string | null;
  readonly bundleVersion: string | null;
  readonly pinned: boolean;
  readonly configRevision: number;
  readonly updatedAt: string;
}

export interface AgentSkillBindingWriteInput {
  readonly agentId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly bundleId?: string;
  readonly bundleVersion?: string;
  readonly pinned: boolean;
  readonly configRevision: number;
  readonly updatedAt: string;
}

interface BindingRow {
  agent_id: string;
  skill_ref_key: string;
  selection: string;
  bundle_id: string | null;
  bundle_version: string | null;
  pinned: number;
  config_revision: number;
  updated_at: string;
}

function mapRow(row: BindingRow): AgentSkillBindingRow {
  return {
    agentId: row.agent_id,
    skillRefKey: row.skill_ref_key,
    selection: row.selection as SkillSelectionMode,
    bundleId: row.bundle_id,
    bundleVersion: row.bundle_version,
    pinned: row.pinned === 1,
    configRevision: row.config_revision,
    updatedAt: row.updated_at,
  };
}

export class AgentSkillBindingStore {
  constructor(private readonly database: Database.Database) {}

  get(agentId: string, skillRefKey: string): AgentSkillBindingRow | null {
    const row = this.database
      .prepare("SELECT * FROM agent_skill_binding_index WHERE agent_id = ? AND skill_ref_key = ?")
      .get(agentId, skillRefKey) as BindingRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  listByAgent(agentId: string): AgentSkillBindingRow[] {
    const rows = this.database
      .prepare("SELECT * FROM agent_skill_binding_index WHERE agent_id = ? ORDER BY skill_ref_key ASC")
      .all(agentId) as BindingRow[];
    return rows.map(mapRow);
  }

  /** 某 Agent 当前配置修订号（无记录时 0；skills.json 每次绑定变更 +1）。 */
  maxRevision(agentId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(config_revision), 0) AS revision FROM agent_skill_binding_index WHERE agent_id = ?",
      )
      .get(agentId) as { revision: number };
    return row.revision;
  }

  /**
   * 整 Agent 投影重建：同一事务内删除该 Agent 旧投影 + 写入新投影。
   * 仅由 Service 在 skills.json 原子写成功后的审计事务内调用。
   */
  rebuild(agentId: string, rows: readonly AgentSkillBindingWriteInput[]): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM agent_skill_binding_index WHERE agent_id = ?").run(agentId);
      const insert = this.database.prepare(
        `INSERT INTO agent_skill_binding_index
          (agent_id, skill_ref_key, selection, bundle_id, bundle_version, pinned, config_revision, updated_at)
         VALUES (@agentId, @skillRefKey, @selection, @bundleId, @bundleVersion, @pinned, @configRevision, @updatedAt)`,
      );
      for (const row of rows) {
        insert.run({
          agentId: row.agentId,
          skillRefKey: row.skillRefKey,
          selection: row.selection,
          bundleId: row.bundleId ?? null,
          bundleVersion: row.bundleVersion ?? null,
          pinned: row.pinned ? 1 : 0,
          configRevision: row.configRevision,
          updatedAt: row.updatedAt,
        });
      }
    })();
  }

  /** 移除某 Agent 的全部投影（skills.json 被删除/重置时保持一致性）。 */
  removeByAgent(agentId: string): void {
    this.database.prepare("DELETE FROM agent_skill_binding_index WHERE agent_id = ?").run(agentId);
  }
}
