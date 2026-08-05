import type Database from "better-sqlite3";

import type { SkillSelectionMode } from "../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 无 Agent Session 临时 Skill 绑定（plans/phase-13.md §9.4）
//
// session_skill_bindings：以 SQLite 为事实来源的**临时**绑定。
// - 只属于当前 Session（不继承 Agent Bundle）；Session 结束后**不自动升级**
//   为 Agent 持久绑定（升级必须走 AgentSkillService 显式 bindSkill）；
// - expires_at 可空（ttlMs 提供时写入）：过期绑定不再进入解析结果；
// - 会话内安装 → 本表临时绑定；一次性激活授权走 skill_activation_grants。
// ═══════════════════════════════════════════════════════════════

export interface SessionSkillBindingRecord {
  readonly sessionId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

interface BindingRow {
  session_id: string;
  skill_ref_key: string;
  selection: string;
  expires_at: string | null;
  created_at: string;
}

function mapRow(row: BindingRow): SessionSkillBindingRecord {
  return {
    sessionId: row.session_id,
    skillRefKey: row.skill_ref_key,
    selection: row.selection as SkillSelectionMode,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class SessionSkillBindingStore {
  constructor(private readonly database: Database.Database) {}

  upsert(input: {
    readonly sessionId: string;
    readonly skillRefKey: string;
    readonly selection: SkillSelectionMode;
    readonly expiresAt?: string;
    readonly createdAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO session_skill_bindings
          (session_id, skill_ref_key, selection, expires_at, created_at)
         VALUES (@sessionId, @skillRefKey, @selection, @expiresAt, @createdAt)
         ON CONFLICT (session_id, skill_ref_key) DO UPDATE SET
           selection = excluded.selection,
           expires_at = excluded.expires_at`,
      )
      .run({
        sessionId: input.sessionId,
        skillRefKey: input.skillRefKey,
        selection: input.selection,
        expiresAt: input.expiresAt ?? null,
        createdAt: input.createdAt,
      });
  }

  listBySession(sessionId: string): SessionSkillBindingRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_skill_bindings WHERE session_id = ? ORDER BY skill_ref_key ASC")
      .all(sessionId) as BindingRow[];
    return rows.map(mapRow);
  }

  get(sessionId: string, skillRefKey: string): SessionSkillBindingRecord | null {
    const row = this.database
      .prepare("SELECT * FROM session_skill_bindings WHERE session_id = ? AND skill_ref_key = ?")
      .get(sessionId, skillRefKey) as BindingRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  remove(sessionId: string, skillRefKey: string): void {
    this.database.prepare("DELETE FROM session_skill_bindings WHERE session_id = ? AND skill_ref_key = ?").run(sessionId, skillRefKey);
  }

  /** 会话结束清理：删除已过期绑定（临时绑定不自动升级为持久绑定）。 */
  removeExpiredBefore(nowIso: string): number {
    return this.database
      .prepare("DELETE FROM session_skill_bindings WHERE expires_at IS NOT NULL AND expires_at < ?")
      .run(nowIso).changes;
  }
}
