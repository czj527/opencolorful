import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 5;

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

  if (current < 3) {
    database.exec("ALTER TABLE sessions ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium'");
    database.prepare("UPDATE schema_version SET version = 3").run();
  }

  if (current < 4) {
    database.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
    database.prepare("UPDATE schema_version SET version = 4").run();
  }

  if (current < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        context_tokens INTEGER,
        context_window INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, turn_id)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
        ON usage_records (created_at);
    `);
    database.prepare("UPDATE schema_version SET version = 5").run();
  }

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${current}`);
  }
}
