import type Database from "better-sqlite3";
import type {
  MemoryFact,
  MemoryFactSource,
  MemoryFactStatus,
} from "../../contracts/memory.js";
import {
  buildMemoryFtsQuery,
  buildMemorySearchText,
  escapeLikePattern,
  isSingleCjkQuery,
  normalizeSearchText,
} from "./cjk-ngram.js";

interface FactRow {
  id: number;
  agent_id: string;
  fact: string;
  search_text: string;
  tags: string;
  fact_time: string | null;
  source: string;
  source_refs: string;
  retention_strength: number;
  activation_strength: number;
  confidence: number;
  valid_until: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: FactRow): MemoryFact {
  return {
    id: row.id,
    agentId: row.agent_id,
    fact: row.fact,
    searchText: row.search_text,
    tags: JSON.parse(row.tags) as readonly string[],
    ...(row.fact_time !== null ? { factTime: row.fact_time } : {}),
    source: row.source as MemoryFactSource,
    sourceRefs: JSON.parse(row.source_refs) as readonly string[],
    retentionStrength: row.retention_strength,
    activationStrength: row.activation_strength,
    confidence: row.confidence,
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    status: row.status as MemoryFactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateMemoryFactInput {
  agentId: string;
  fact: string;
  tags: readonly string[];
  factTime?: string;
  validUntil?: string;
  source: Extract<MemoryFactSource, "agent_approved" | "user_intent">;
  sourceRefs: readonly string[];
  confidence: number;
  retentionStrength: number;
  activationStrength?: number;
}

export class MemoryFactStore {
  constructor(private readonly database: Database.Database) {}

  getById(id: number): MemoryFact | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_facts WHERE id = ?")
      .get(id) as FactRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * 列出 Agent 的事实。默认排除 forgotten/suppressed（superseded 保留可查）。
   * tags 过滤用 json_each 精确匹配。
   */
  listByAgent(
    agentId: string,
    opts?: {
      query?: string;
      tags?: string[];
      limit?: number;
    },
  ): MemoryFact[] {
    const conditions: string[] = [
      "agent_id = ?",
      "status NOT IN ('forgotten', 'suppressed')",
    ];
    const params: unknown[] = [agentId];

    if (opts?.query) {
      conditions.push("fact LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(opts.query)}%`);
    }

    if (opts?.tags && opts.tags.length > 0) {
      for (const tag of opts.tags) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(memory_facts.tags) WHERE value = ?)",
        );
        params.push(tag);
      }
    }

    const limit = opts?.limit ?? 50;

    const rows = this.database
      .prepare(
        `SELECT * FROM memory_facts
         WHERE ${conditions.join(" AND ")}
         ORDER BY fact_time DESC, retention_strength DESC
         LIMIT ?`,
      )
      .all(...params, limit) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * FTS5 全文搜索 + CJK 单字 LIKE 降级（对 fact 列）。
   * 默认排除 forgotten/suppressed。
   */
  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  createFact(input: CreateMemoryFactInput): MemoryFact {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO memory_facts
        (agent_id, fact, search_text, tags, fact_time, source, source_refs,
         retention_strength, activation_strength, confidence, valid_until, status,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      input.agentId, input.fact, buildMemorySearchText(input.fact), JSON.stringify(input.tags),
      input.factTime ?? null, input.source, JSON.stringify(input.sourceRefs),
      input.retentionStrength, input.activationStrength ?? 0, input.confidence,
      input.validUntil ?? null, now, now,
    );
    return this.getById(Number(result.lastInsertRowid)) as MemoryFact;
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  updateRetention(factId: number, retentionStrength: number, now = new Date()): { previous: number; updated: MemoryFact } {
    const current = this.getById(factId);
    if (!current) throw new Error(`事实不存在: ${factId}`);
    if (current.retentionStrength === retentionStrength) throw new Error(`事实强度未发生变化: ${factId}`);
    this.database.prepare("UPDATE memory_facts SET retention_strength = ?, updated_at = ? WHERE id = ?")
      .run(retentionStrength, now.toISOString(), factId);
    return { previous: current.retentionStrength, updated: this.getById(factId) as MemoryFact };
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  setActivation(factId: number, activationStrength: number): MemoryFact {
    const result = this.database.prepare("UPDATE memory_facts SET activation_strength = ?, updated_at = ? WHERE id = ?")
      .run(activationStrength, new Date().toISOString(), factId);
    if (result.changes !== 1) throw new Error(`事实不存在: ${factId}`);
    return this.getById(factId) as MemoryFact;
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  supersedeFact(input: { factId: number; newFactId: number; validUntil?: string }): MemoryFact {
    const old = this.getById(input.factId);
    if (!old) throw new Error(`事实不存在: ${input.factId}`);
    const result = this.database.prepare("UPDATE memory_facts SET status = 'superseded', valid_until = ?, updated_at = ? WHERE id = ?")
      .run(input.validUntil ?? new Date().toISOString(), new Date().toISOString(), input.factId);
    if (result.changes !== 1) throw new Error(`事实不存在: ${input.factId}`);
    return this.getById(input.factId) as MemoryFact;
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  markForgotten(factId: number, opts?: { reason?: string }): MemoryFact {
    return this.setStatus(factId, "forgotten");
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  restoreFact(factId: number): MemoryFact { return this.setStatus(factId, "active"); }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  markSuppressed(factId: number): MemoryFact { return this.setStatus(factId, "suppressed"); }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  mergeFacts(input: { factIds: readonly number[]; mergedFactId: number }): MemoryFact {
    const now = new Date().toISOString();
    const placeholders = input.factIds.map(() => "?").join(",");
    this.database.prepare(`UPDATE memory_facts SET status = 'superseded', source_refs = source_refs, updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...input.factIds);
    return this.getById(input.mergedFactId) as MemoryFact;
  }

  /** 仅供 MemoryPolicy 应用路径，不对主 Agent 工具暴露。 */
  getActiveById(factId: number): MemoryFact | undefined {
    const row = this.database.prepare("SELECT * FROM memory_facts WHERE id = ? AND status = 'active'").get(factId) as FactRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  private setStatus(factId: number, status: MemoryFactStatus): MemoryFact {
    const result = this.database.prepare("UPDATE memory_facts SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), factId);
    if (result.changes !== 1) throw new Error(`事实不存在: ${factId}`);
    return this.getById(factId) as MemoryFact;
  }

  searchByFts(
    agentId: string,
    query: string,
    limit = 20,
  ): MemoryFact[] {
    if (isSingleCjkQuery(query)) {
      const pattern = `%${escapeLikePattern(query)}%`;
      const rows = this.database
        .prepare(
          `SELECT * FROM memory_facts
           WHERE agent_id = ?
             AND status NOT IN ('forgotten', 'suppressed')
             AND fact LIKE ? ESCAPE '\\'
           ORDER BY retention_strength DESC
           LIMIT ?`,
        )
        .all(agentId, pattern, limit) as FactRow[];
      return rows.map(mapRow);
    }

    const ftsQuery = buildMemoryFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.database
      .prepare(
        `SELECT mf.* FROM memory_facts mf
         JOIN memory_facts_fts fts ON mf.id = fts.rowid
         WHERE memory_facts_fts MATCH ?
           AND mf.agent_id = ?
           AND mf.status NOT IN ('forgotten', 'suppressed')
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, agentId, limit) as FactRow[];
    return rows.map(mapRow);
  }
}
