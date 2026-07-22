import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 2;

export function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      session_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      provider TEXT,
      model TEXT
    );

    CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
      ON sessions (updated_at DESC);
  `);

  const version = database
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .pluck()
    .get() as number | undefined;

  if (version === undefined) {
    database.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
  }

  const current = database
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .pluck()
    .get() as number;

  if (current < 2) {
    database.exec(`
      ALTER TABLE sessions ADD COLUMN tool_mode TEXT DEFAULT 'off';
      ALTER TABLE sessions ADD COLUMN workspace_cwd TEXT;
      ALTER TABLE sessions ADD COLUMN workspace_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_confirmed IN (0, 1));
    `);
    database.prepare("UPDATE schema_version SET version = 2").run();
  }

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${current}`);
  }
}
