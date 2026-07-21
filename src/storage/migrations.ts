import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

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
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
  } else if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${version}`);
  }
}
