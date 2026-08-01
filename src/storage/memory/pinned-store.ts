import type Database from "better-sqlite3";
import type { PinnedMemory } from "../../contracts/memory.js";

interface PinnedRow {
  id: string;
  agent_id: string;
  content: string;
  created_at: string;
}

function mapRow(row: PinnedRow): PinnedMemory {
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface PinnedMemoryInput {
  id: string;
  agentId: string;
  content: string;
}

export class PinnedMemoryStore {
  constructor(private readonly database: Database.Database) {}

  add(input: PinnedMemoryInput): PinnedMemory {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO pinned_memories
          (id, agent_id, content, created_at)
         VALUES (@id, @agentId, @content, @createdAt)`,
      )
      .run({
        id: input.id,
        agentId: input.agentId,
        content: input.content,
        createdAt,
      });
    return this.get(input.id) as PinnedMemory;
  }

  get(id: string): PinnedMemory | undefined {
    const row = this.database
      .prepare("SELECT * FROM pinned_memories WHERE id = ?")
      .get(id) as PinnedRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  remove(id: string): void {
    this.database
      .prepare("DELETE FROM pinned_memories WHERE id = ?")
      .run(id);
  }

  listByAgent(agentId: string): PinnedMemory[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM pinned_memories WHERE agent_id = ? ORDER BY created_at ASC",
      )
      .all(agentId) as PinnedRow[];
    return rows.map(mapRow);
  }
}
