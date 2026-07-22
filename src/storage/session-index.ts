import type Database from "better-sqlite3";

export interface CreateSessionInput {
  readonly id: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly createdAt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly toolMode?: string;
  readonly workspaceCwd?: string;
  readonly workspaceConfirmed?: boolean;
}

export interface SessionMetadata {
  readonly id: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly toolMode: string;
  readonly workspaceCwd: string | null;
  readonly workspaceConfirmed: boolean;
}

interface SessionRow {
  id: string;
  title: string;
  session_path: string;
  created_at: string;
  updated_at: string;
  archived: number;
  provider: string | null;
  model: string | null;
  tool_mode: string;
  workspace_cwd: string | null;
  workspace_confirmed: number;
}

function mapRow(row: SessionRow | undefined): SessionMetadata | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    title: row.title,
    sessionPath: row.session_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    provider: row.provider,
    model: row.model,
    toolMode: row.tool_mode ?? "off",
    workspaceCwd: row.workspace_cwd,
    workspaceConfirmed: row.workspace_confirmed === 1,
  };
}

export class SessionIndex {
  constructor(private readonly database: Database.Database) {}

  create(input: CreateSessionInput): SessionMetadata {
    const now = input.createdAt ?? new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO sessions
          (id, title, session_path, created_at, updated_at, provider, model, tool_mode, workspace_cwd, workspace_confirmed)
         VALUES (@id, @title, @sessionPath, @createdAt, @updatedAt, @provider, @model, @toolMode, @workspaceCwd, @workspaceConfirmed)`,
      )
      .run({
        id: input.id,
        title: input.title,
        sessionPath: input.sessionPath,
        createdAt: now,
        updatedAt: now,
        provider: input.provider ?? null,
        model: input.model ?? null,
        toolMode: input.toolMode ?? "off",
        workspaceCwd: input.workspaceCwd ?? null,
        workspaceConfirmed: input.workspaceConfirmed ? 1 : 0,
      });
    return this.get(input.id) as SessionMetadata;
  }

  updateSettings(
    id: string,
    settings: { toolMode?: string; workspaceCwd?: string; workspaceConfirmed?: boolean },
    updatedAt = new Date().toISOString(),
  ): SessionMetadata {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [updatedAt];
    if (settings.toolMode !== undefined) {
      sets.push("tool_mode = ?");
      params.push(settings.toolMode);
    }
    if (settings.workspaceCwd !== undefined) {
      sets.push("workspace_cwd = ?");
      params.push(settings.workspaceCwd);
    }
    if (settings.workspaceConfirmed !== undefined) {
      sets.push("workspace_confirmed = ?");
      params.push(settings.workspaceConfirmed ? 1 : 0);
    }
    params.push(id);
    this.database
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this.get(id) as SessionMetadata;
  }

  get(id: string): SessionMetadata | undefined {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return mapRow(row);
  }

  list(options: { readonly includeArchived?: boolean } = {}): SessionMetadata[] {
    const rows = options.includeArchived
      ? this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all()
      : this.database
          .prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY updated_at DESC")
          .all();
    return (rows as SessionRow[]).map((row) => mapRow(row) as SessionMetadata);
  }

  touch(id: string, updatedAt = new Date().toISOString()): SessionMetadata {
    const result = this.database
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
    if (result.changes !== 1) {
      throw new Error(`Session 不存在: ${id}`);
    }
    return this.get(id) as SessionMetadata;
  }

  archive(id: string, updatedAt = new Date().toISOString()): SessionMetadata {
    const result = this.database
      .prepare("UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
    if (result.changes !== 1) {
      throw new Error(`Session 不存在: ${id}`);
    }
    return this.get(id) as SessionMetadata;
  }
}
