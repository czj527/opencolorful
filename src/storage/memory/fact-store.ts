import type Database from "better-sqlite3";
import type {
  MemoryFact,
  MemoryFactSource,
  MemoryFactStatus,
} from "../../contracts/memory.js";
import {
  buildMemoryFtsQuery,
  escapeLikePattern,
  isSingleCjkQuery,
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

/**
 * MemoryFactStore：Phase 10 只读。
 * 写入从 Phase 10.5 记忆 Agent 开始；测试需要数据时用 raw SQL INSERT。
 */
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
