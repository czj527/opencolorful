import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 9;

/** 迁移进度上报（Phase 11 埋点用；observer 在迁移真正执行时才回调） */
export interface MigrationObserver {
  (report: { from: number; to: number }): void;
}

export function applyMigrations(database: Database.Database, observer?: MigrationObserver): void {
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

  // v8：Phase 11 统一可观测性（plans/phase-11.md §5）
  // activity_events + FTS / audit_events / observability_trace_links /
  // activity_daily_metrics / observability_state；与 v7 升级、空库新建两条路径同构。
  if (current < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        event_version INTEGER NOT NULL DEFAULT 1,
        recorded_at TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_name TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('trace','debug','info','warn','error','fatal')),
        status TEXT CHECK (status IN ('started','processing','completed','degraded','failed','cancelled','denied','deferred','retrying','skipped','interrupted')),
        significance TEXT NOT NULL CHECK (significance IN ('routine','notable','milestone')),
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        owner_agent_id TEXT,
        session_id TEXT,
        run_id TEXT,
        turn_id TEXT,
        task_id TEXT,
        subagent_run_id TEXT,
        tool_call_id TEXT,
        plugin_id TEXT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        operation_id TEXT,
        correlation_id TEXT,
        duration_ms INTEGER,
        error_code TEXT,
        retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        producer_component TEXT NOT NULL,
        producer_process_type TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_activity_recorded_at ON activity_events(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_agent_time ON activity_events(owner_agent_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_session_time ON activity_events(session_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_trace ON activity_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_activity_operation ON activity_events(operation_id);
      CREATE INDEX IF NOT EXISTS idx_activity_event_time ON activity_events(event_name, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_status_time ON activity_events(status, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_level_time ON activity_events(level, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_significance_time ON activity_events(significance, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_plugin_time ON activity_events(plugin_id, recorded_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS activity_events_fts USING fts5(
        event_name,
        category,
        error_code,
        search_text,
        content='activity_events',
        content_rowid='id'
      );
      INSERT INTO activity_events_fts(rowid, event_name, category, error_code, search_text)
        SELECT id, event_name, category, COALESCE(error_code, ''), search_text FROM activity_events;
      CREATE TRIGGER IF NOT EXISTS activity_events_ai AFTER INSERT ON activity_events BEGIN
        INSERT INTO activity_events_fts(rowid, event_name, category, error_code, search_text)
        VALUES (new.id, new.event_name, new.category, COALESCE(new.error_code, ''), new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS activity_events_ad AFTER DELETE ON activity_events BEGIN
        INSERT INTO activity_events_fts(activity_events_fts, rowid, event_name, category, error_code, search_text)
        VALUES ('delete', old.id, old.event_name, old.category, COALESCE(old.error_code, ''), old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS activity_events_au AFTER UPDATE ON activity_events BEGIN
        INSERT INTO activity_events_fts(activity_events_fts, rowid, event_name, category, error_code, search_text)
        VALUES ('delete', old.id, old.event_name, old.category, COALESCE(old.error_code, ''), old.search_text);
        INSERT INTO activity_events_fts(rowid, event_name, category, error_code, search_text)
        VALUES (new.id, new.event_name, new.category, COALESCE(new.error_code, ''), new.search_text);
      END;

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        ledger_epoch INTEGER NOT NULL DEFAULT 1,
        schema_version INTEGER NOT NULL DEFAULT 1,
        event_version INTEGER NOT NULL DEFAULT 1,
        recorded_at TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        action TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allowed','denied','required','deferred','reset')),
        reason_code TEXT,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        owner_agent_id TEXT,
        session_id TEXT,
        trace_id TEXT NOT NULL,
        operation_id TEXT,
        policy_version TEXT,
        before_revision TEXT,
        after_revision TEXT,
        changed_fields_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT,
        record_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_epoch_time ON audit_events(ledger_epoch, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_events(owner_agent_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_events(action, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);

      CREATE TABLE IF NOT EXISTS observability_trace_links (
        source_trace_id TEXT NOT NULL,
        target_trace_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        source_event_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_trace_id, target_trace_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_trace_links_source ON observability_trace_links(source_trace_id);
      CREATE INDEX IF NOT EXISTS idx_trace_links_target ON observability_trace_links(target_trace_id);

      CREATE TABLE IF NOT EXISTS activity_daily_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_date TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL DEFAULT '',
        metric_kind TEXT NOT NULL,
        dimension_hash TEXT NOT NULL DEFAULT '',
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        UNIQUE (metric_date, owner_agent_id, metric_kind, dimension_hash)
      );

      CREATE TABLE IF NOT EXISTS observability_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO observability_state (key, value) VALUES ('audit.ledger_epoch', '1');
    `);
    database.prepare("UPDATE schema_version SET version = 8").run();
  }

  // v9：评审 P1（第六轮）——审计表保存事件名与生命周期身份。
  // 三阶段（started/terminal）此前只有 action+decision 可辨识，started 与
  // completed 记录在查询 API 中完全相同；event_name 列使生命周期可查询、
  // 可关联（与路由生成的 operationId 配对），旧行回填为 NULL（无法从
  // action 可靠反推事件名，查询 API 对此兼容）。
  if (current < 9) {
    database.transaction(() => {
      const columns = database.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "event_name")) {
        database.exec("ALTER TABLE audit_events ADD COLUMN event_name TEXT");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_event_name ON audit_events(event_name, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_operation ON audit_events(operation_id);
      `);
      database.prepare("UPDATE schema_version SET version = 9").run();
    })();
  }

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${current}`);
  }

  if (current < CURRENT_SCHEMA_VERSION) {
    observer?.({ from: current, to: CURRENT_SCHEMA_VERSION });
  }
}
