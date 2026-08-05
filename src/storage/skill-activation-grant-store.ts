import type Database from "better-sqlite3";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Skill 一次性激活授权（plans/phase-13.md §10.2 / §11.5）
//
// skill_activation_grants：以 SQLite 为事实来源。
// - 会话内安装后，当前 turn 通过 grant 立即使用精确 SkillRef（append-only
//   overlay，不修改已开始的 Snapshot、不扩大任何平台权限）；
// - 一次性 + 过期：consumed_at 非空 → 已消费；expires_at 已过 → 过期；
// - 消费必须原子（WHERE consumed_at IS NULL），重放/过期返回稳定 reasonCode
//   （skill_activation_reused / skill_activation_expired / skill_activation_denied）；
// - grant 绑定 agentId + sessionId + skillRefKey + contentHash + issuedTurnId。
// ═══════════════════════════════════════════════════════════════

export interface SkillActivationGrantRecord {
  readonly grantId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly skillRefKey: string;
  readonly contentHash: string;
  readonly issuedTurnId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly reason: string;
}

interface GrantRow {
  grant_id: string;
  agent_id: string;
  session_id: string;
  skill_ref_key: string;
  content_hash: string;
  issued_turn_id: string;
  expires_at: string;
  consumed_at: string | null;
  reason: string;
}

function mapRow(row: GrantRow): SkillActivationGrantRecord {
  return {
    grantId: row.grant_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    skillRefKey: row.skill_ref_key,
    contentHash: row.content_hash,
    issuedTurnId: row.issued_turn_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    reason: row.reason,
  };
}

export class SkillActivationGrantStore {
  constructor(private readonly database: Database.Database) {}

  insert(input: SkillActivationGrantRecord): void {
    this.database
      .prepare(
        `INSERT INTO skill_activation_grants
          (grant_id, agent_id, session_id, skill_ref_key, content_hash, issued_turn_id, expires_at, consumed_at, reason)
         VALUES (@grantId, @agentId, @sessionId, @skillRefKey, @contentHash, @issuedTurnId, @expiresAt, @consumedAt, @reason)`,
      )
      .run({
        grantId: input.grantId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        skillRefKey: input.skillRefKey,
        contentHash: input.contentHash,
        issuedTurnId: input.issuedTurnId,
        expiresAt: input.expiresAt,
        consumedAt: input.consumedAt ?? null,
        reason: input.reason,
      });
  }

  get(grantId: string): SkillActivationGrantRecord | null {
    const row = this.database.prepare("SELECT * FROM skill_activation_grants WHERE grant_id = ?").get(grantId) as GrantRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  listBySession(sessionId: string): SkillActivationGrantRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM skill_activation_grants WHERE session_id = ? ORDER BY expires_at ASC")
      .all(sessionId) as GrantRow[];
    return rows.map(mapRow);
  }

  /**
   * 原子消费：仅当尚未消费时写入 consumed_at。
   * 返回 true = 本次调用赢得消费（一次性语义）；false = 已被消费（重放）。
   */
  markConsumed(grantId: string, consumedAt: string): boolean {
    const result = this.database
      .prepare("UPDATE skill_activation_grants SET consumed_at = ? WHERE grant_id = ? AND consumed_at IS NULL")
      .run(consumedAt, grantId);
    return result.changes > 0;
  }
}
