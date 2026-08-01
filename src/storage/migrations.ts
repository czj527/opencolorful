import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 7;

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

  // v6：Phase 10 记忆系统底座（plans/phase-10.md 第三节）
  // 两条通道：上下文记忆（session_summaries/水位线）与长期记忆输入
  // （memory_events/memory_facts/recall ledger/journal/batch）。
  // memory_facts 的内容与强度由 Phase 10.5 审批后写入，Phase 10 为空属预期。
  if (current < 6) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT NOT NULL,
        branch_revision TEXT NOT NULL DEFAULT '',
        agent_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        cursor_json TEXT NOT NULL DEFAULT '{}',
        source_start_entry TEXT,
        source_end_entry TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, branch_revision)
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_agent ON session_summaries(agent_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_agent_branch ON session_summaries(agent_id, branch_revision);

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch_revision TEXT NOT NULL DEFAULT '',
        source_start_entry TEXT,
        source_end_entry TEXT,
        date TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        topics TEXT NOT NULL DEFAULT '[]',
        search_text TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        duration_sec INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','forgotten','suppressed')),
        created_at TEXT NOT NULL,
        UNIQUE (session_id, branch_revision, source_start_entry, source_end_entry)
      );
      CREATE INDEX IF NOT EXISTS idx_events_agent_date ON memory_events(agent_id, date);
      CREATE INDEX IF NOT EXISTS idx_events_session ON memory_events(session_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
        summary, topics, search_text,
        content=memory_events, content_rowid=rowid, tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memory_events_ai AFTER INSERT ON memory_events BEGIN
        INSERT INTO memory_events_fts(rowid, summary, topics, search_text)
          VALUES (new.rowid, new.summary, new.topics, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_events_ad AFTER DELETE ON memory_events BEGIN
        INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, topics, search_text)
          VALUES ('delete', old.rowid, old.summary, old.topics, old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_events_au AFTER UPDATE ON memory_events BEGIN
        INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, topics, search_text)
          VALUES ('delete', old.rowid, old.summary, old.topics, old.search_text);
        INSERT INTO memory_events_fts(rowid, summary, topics, search_text)
          VALUES (new.rowid, new.summary, new.topics, new.search_text);
      END;

      CREATE TABLE IF NOT EXISTS memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        fact_time TEXT,
        source TEXT NOT NULL DEFAULT 'agent_approved'
          CHECK (source IN ('agent_proposed','agent_approved','user_intent')),
        source_refs TEXT NOT NULL DEFAULT '[]',
        retention_strength INTEGER NOT NULL DEFAULT 0
          CHECK (retention_strength BETWEEN 0 AND 100),
        activation_strength INTEGER NOT NULL DEFAULT 0
          CHECK (activation_strength BETWEEN 0 AND 100),
        confidence REAL NOT NULL DEFAULT 0
          CHECK (confidence BETWEEN 0 AND 1),
        valid_until TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','forgotten','superseded','suppressed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_agent ON memory_facts(agent_id);
      CREATE INDEX IF NOT EXISTS idx_facts_time ON memory_facts(fact_time);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
        fact, search_text,
        content=memory_facts, content_rowid=id, tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(rowid, fact, search_text)
          VALUES (new.id, new.fact, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, search_text)
          VALUES ('delete', old.id, old.fact, old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, search_text)
          VALUES ('delete', old.id, old.fact, old.search_text);
        INSERT INTO memory_facts_fts(rowid, fact, search_text)
          VALUES (new.id, new.fact, new.search_text);
      END;

      CREATE TABLE IF NOT EXISTS memory_recalls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        recall_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session')),
        target_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('facts','events','source')),
        source_type TEXT NOT NULL DEFAULT 'memory_recall',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recalls_agent ON memory_recalls(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS memory_recall_episodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('started','layer_changed','completed','empty','failed','cancelled')),
        result_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_journal (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('user','main_agent','memory_agent','system')),
        intent_type TEXT NOT NULL CHECK (intent_type IN ('remember','forget','pin','unpin','supersede','merge','suppress','restore')),
        target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session','memory')),
        target_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','applied','revoked')),
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_journal_agent_status ON memory_journal(agent_id, status, created_at);

      CREATE TABLE IF NOT EXISTS memory_batches (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        revision_json TEXT NOT NULL DEFAULT '{}',
        source_start_entry TEXT,
        source_end_entry TEXT,
        status TEXT NOT NULL DEFAULT 'sealed'
          CHECK (status IN ('provisional','sealed','processing','applied','deferred','failed')),
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_batches_agent_status ON memory_batches(agent_id, status, created_at);

      CREATE TABLE IF NOT EXISTS memory_daily_state (
        agent_id TEXT NOT NULL,
        date TEXT NOT NULL,
        step TEXT NOT NULL,
        done_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, date, step)
      );

      CREATE TABLE IF NOT EXISTS memory_watermarks (
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('summary','events','markdown','batch')),
        branch_revision TEXT NOT NULL DEFAULT '',
        cursor_json TEXT NOT NULL DEFAULT '{}',
        dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0,1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, scope, branch_revision)
      );

      CREATE TABLE IF NOT EXISTS scheduler_state (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle','running','deferred','failed')),
        last_daily_date TEXT,
        last_daily_completed_at TEXT,
        last_weekly_completed_at TEXT,
        next_retry_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_recall_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id TEXT NOT NULL,
        recall_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        layer TEXT CHECK (layer IN ('facts','events','source')),
        status TEXT NOT NULL CHECK (status IN ('started','layer_changed','completed','empty','failed','cancelled')),
        result_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recall_events_episode ON memory_recall_events(episode_id, id);

      CREATE TABLE IF NOT EXISTS pinned_memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pinned_agent ON pinned_memories(agent_id);
    `);
    database.prepare("UPDATE schema_version SET version = 6").run();
  }

  // v7：Phase 10.5 记忆 Agent 审批与高优先级 intent（plans/phase-10.5.md §三/§七）
  if (current < 7) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS memory_mutation_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('create_fact','strength_change','supersede','merge','forget','restore','longterm_projection')),
        target_type TEXT CHECK (target_type IN ('fact','event','session')),
        target_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        previous_state TEXT,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','applied','reverted')),
        policy_reason TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_agent_status ON memory_mutation_proposals(agent_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_run ON memory_mutation_proposals(run_id);

      -- 高优先级 intent（用户明确 remember/forget）→ turn 后 micro-seal 专项处理
      ALTER TABLE memory_journal ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_journal_agent_priority ON memory_journal(agent_id, priority, status, created_at);
    `);
    database.prepare("UPDATE schema_version SET version = 7").run();
  }

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${current}`);
  }
}
