import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 14;

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

  // v10：Phase 12 插件系统规范化状态表（plans/phase-12.md §7.3）。
  // 事实来源：安装 Artifact 中的原始 Manifest 是包内容事实；plugin_installations
  // 是安装/active version/启用状态事实；plugin_grants / agent_plugin_bindings 是
  // 权限与 Agent 可见性事实；plugin_configs 是非敏感配置及 revision 的事实来源；
  // plugin_secrets 落 auth/plugin-secrets.json（PluginSecretStore，本表不存值）；
  // plugin_runtime_instances 是运行实例/健康/restart budget 事实；
  // plugin_source_cache 是来源元数据与版本索引（可清理，provenance 不随删）；
  // plugin_operations 记录安装/更新/回滚/卸载操作与补偿状态（中断可恢复）。
  if (current < 10) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS plugin_installations (
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('discovered','staged','installed','enabled','degraded','disabled','failed','removed')),
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_version TEXT,
        artifact_sha256 TEXT NOT NULL,
        artifact_size INTEGER NOT NULL DEFAULT 0,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        manifest_json TEXT NOT NULL DEFAULT '{}',
        installed_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_install_active ON plugin_installations(plugin_id, active);
      CREATE INDEX IF NOT EXISTS idx_plugin_install_status ON plugin_installations(status);

      CREATE TABLE IF NOT EXISTS plugin_grants (
        plugin_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allowed','denied')),
        revision INTEGER NOT NULL,
        granted_at TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        PRIMARY KEY (plugin_id, capability)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_grants_revision ON plugin_grants(plugin_id, revision);

      CREATE TABLE IF NOT EXISTS plugin_configs (
        plugin_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_configs_revision ON plugin_configs(plugin_id, revision);

      CREATE TABLE IF NOT EXISTS agent_plugin_bindings (
        agent_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        contributions_json TEXT NOT NULL DEFAULT '[]',
        grant_revision INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, plugin_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_plugin_bindings_plugin ON agent_plugin_bindings(plugin_id, agent_id);

      CREATE TABLE IF NOT EXISTS plugin_runtime_instances (
        runtime_instance_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting','running','stopped','crashed','degraded')),
        restart_count INTEGER NOT NULL DEFAULT 0,
        last_health_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (runtime_instance_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_runtime_plugin ON plugin_runtime_instances(plugin_id, status);

      CREATE TABLE IF NOT EXISTS plugin_source_cache (
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        version TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (source_type, source_ref, version)
      );

      CREATE TABLE IF NOT EXISTS plugin_operations (
        operation_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('install','update','rollback','uninstall','enable','disable','dev-install','dev-reload')),
        status TEXT NOT NULL CHECK (status IN ('started','completed','failed','compensated')),
        from_version TEXT,
        to_version TEXT,
        reason_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_operations_plugin ON plugin_operations(plugin_id, status);
    `);
    database.prepare("UPDATE schema_version SET version = 10").run();
  }

  // v11：Phase 13 Skill 系统事实表（plans/phase-13.md §9.1）。
  // 事实来源：skills 是安装/版本/状态事实；skill_files 是正文文件清单（正文仍在
  // 文件系统）；skill_bundles/skill_bundle_items 是版本化 Bundle 组合事实；
  // agent_skill_binding_index 只是可从 agents/<agentId>/skills.json 重建的查询投影
  // （skills.json 是 Agent 持久绑定唯一事实来源）；session_skill_bindings 与
  // skill_activation_grants 以 SQLite 为事实来源（Session 绑定/一次性激活授权）；
  // skill_operations 记录安装/绑定/激活等操作与补偿状态（中断可恢复）。
  if (current < 11) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        skill_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin','managed','plugin','workspace','external')),
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '{}',
        validity TEXT NOT NULL CHECK (validity IN ('valid','invalid')),
        trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
        readiness TEXT NOT NULL CHECK (readiness IN ('ready','degraded','blocked','incompatible')),
        selection TEXT NOT NULL CHECK (selection IN ('implicit','explicit-only','disabled','shadowed')),
        blocked_reason TEXT,
        compatibility_level TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, source_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source_kind, source_id);
      CREATE INDEX IF NOT EXISTS idx_skills_readiness ON skills(readiness);

      CREATE TABLE IF NOT EXISTS skill_files (
        skill_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        version TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'support',
        PRIMARY KEY (skill_id, source_id, version, relative_path)
      );

      CREATE TABLE IF NOT EXISTS skill_bundles (
        bundle_id TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin','managed','plugin','workspace','external')),
        source_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        supersedes_version TEXT,
        PRIMARY KEY (bundle_id, version)
      );

      CREATE TABLE IF NOT EXISTS skill_bundle_items (
        bundle_id TEXT NOT NULL,
        bundle_version TEXT NOT NULL,
        skill_ref_key TEXT NOT NULL,
        selection TEXT NOT NULL CHECK (selection IN ('implicit','explicit-only','disabled')),
        ordinal INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bundle_id, bundle_version, skill_ref_key)
      );

      -- 查询投影：可从 agents/<agentId>/skills.json 重建（skills.json 是唯一事实来源）
      CREATE TABLE IF NOT EXISTS agent_skill_binding_index (
        agent_id TEXT NOT NULL,
        skill_ref_key TEXT NOT NULL,
        selection TEXT NOT NULL CHECK (selection IN ('implicit','explicit-only','disabled')),
        bundle_id TEXT,
        bundle_version TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        config_revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, skill_ref_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_skill_binding_agent ON agent_skill_binding_index(agent_id);

      CREATE TABLE IF NOT EXISTS session_skill_bindings (
        session_id TEXT NOT NULL,
        skill_ref_key TEXT NOT NULL,
        selection TEXT NOT NULL CHECK (selection IN ('implicit','explicit-only','disabled')),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, skill_ref_key)
      );

      CREATE TABLE IF NOT EXISTS skill_activation_grants (
        grant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        skill_ref_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        issued_turn_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        reason TEXT NOT NULL DEFAULT 'session-install',
        PRIMARY KEY (grant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_activation_session ON skill_activation_grants(session_id, skill_ref_key);

      CREATE TABLE IF NOT EXISTS skill_operations (
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('install','update','rollback','uninstall','bind','unbind','activate','link','unlink')),
        source_ref TEXT,
        agent_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('started','completed','failed','compensated')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_operations_status ON skill_operations(kind, status);
    `);
    database.prepare("UPDATE schema_version SET version = 11").run();
  }

  // v12：Phase 14 Subagent Runtime 事实表（plans/phase-14.md §16.2）。
  // 事实来源：subagent_threads 是 Thread 生命周期/模型/能力 ceiling 事实；
  // subagent_runs 是 Run 状态机事实（SQLite 为权威，transcript 不替代）；
  // subagent_messages 是父子协议 Envelope 与严格 sequence 事实（store-first）；
  // subagent_artifacts 是 Artifact 元数据（正文在 agents/<agent>/subagents/ 目录）；
  // subagent_parent_mailbox 是父 Mailbox 投递状态与幂等事实；
  // subagent_workspace_leases 是当前有效写 Lease（过期行由恢复/housekeeping 清理）。
  // observability 查询列：activity_events/audit_events 增加 subagent_thread_id、
  // subagent_run_id（§19.1），供 /logs?subagent= 过滤与索引。
  if (current < 12) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS subagent_threads (
          thread_id TEXT PRIMARY KEY NOT NULL,
          owner_agent_id TEXT NOT NULL,
          parent_session_id TEXT NOT NULL,
          created_from_turn_id TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open','closing','closed')),
          model_provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_source TEXT NOT NULL CHECK (model_source IN ('user_default','parent_request','parent_inherited')),
          thinking_level TEXT NOT NULL,
          workspace_cwd TEXT NOT NULL,
          capability_ceiling_json TEXT NOT NULL DEFAULT '{}',
          context_packet_hash TEXT NOT NULL,
          next_message_sequence INTEGER NOT NULL DEFAULT 1,
          next_run_ordinal INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          closed_at TEXT,
          close_reason TEXT,
          audit_pending_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_threads_owner ON subagent_threads(owner_agent_id, parent_session_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_subagent_threads_session ON subagent_threads(parent_session_id, status);

        CREATE TABLE IF NOT EXISTS subagent_runs (
          run_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES subagent_threads(thread_id),
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued','starting','running','waiting_for_input','cancelling','succeeded','failed','cancelled','timed_out','interrupted','budget_exhausted')),
          trigger_message_id TEXT NOT NULL,
          snapshot_id TEXT,
          snapshot_json TEXT,
          limits_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          reason_code TEXT,
          audit_pending_json TEXT,
          current_phase TEXT,
          current_tool TEXT,
          iteration_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          last_activity_at TEXT,
          started_at TEXT,
          finished_at TEXT,
          lease_boot_id TEXT,
          lease_holder_id TEXT,
          lease_expires_at TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (thread_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_thread ON subagent_runs(thread_id, status);
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);

        CREATE TABLE IF NOT EXISTS subagent_messages (
          message_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES subagent_threads(thread_id),
          run_id TEXT NOT NULL REFERENCES subagent_runs(run_id),
          sequence INTEGER NOT NULL,
          envelope_json TEXT NOT NULL,
          message_type TEXT NOT NULL CHECK (message_type IN ('task','progress','steer','input_required','result','error','cancel','status')),
          sender_kind TEXT NOT NULL CHECK (sender_kind IN ('parent_agent','subagent','system')),
          recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('parent_agent','subagent')),
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('immediate','queue','interrupt','mailbox')),
          delivery_status TEXT NOT NULL CHECK (delivery_status IN ('queued','delivering','delivered','failed')),
          consumed_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_messages_thread_seq ON subagent_messages(thread_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_subagent_messages_run ON subagent_messages(run_id);

        CREATE TABLE IF NOT EXISTS subagent_artifacts (
          artifact_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES subagent_threads(thread_id),
          run_id TEXT NOT NULL REFERENCES subagent_runs(run_id),
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT,
          content_hash TEXT NOT NULL,
          size_bytes INTEGER,
          resource_kind TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          canonical_path TEXT,
          visibility TEXT NOT NULL CHECK (visibility IN ('parent','user','private')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_artifacts_thread ON subagent_artifacts(thread_id, run_id);

        CREATE TABLE IF NOT EXISTS subagent_parent_mailbox (
          mailbox_id TEXT PRIMARY KEY NOT NULL,
          owner_agent_id TEXT NOT NULL,
          parent_session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES subagent_threads(thread_id),
          run_id TEXT NOT NULL REFERENCES subagent_runs(run_id),
          message_id TEXT NOT NULL UNIQUE,
          notification_kind TEXT NOT NULL CHECK (notification_kind IN ('started','input_required','completed','failed','cancelled','timed_out','interrupted','budget_exhausted')),
          status TEXT NOT NULL CHECK (status IN ('queued','delivering','delivered','suppressed','failed')),
          trigger_parent_turn INTEGER NOT NULL DEFAULT 0 CHECK (trigger_parent_turn IN (0, 1)),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          last_error_code TEXT,
          operation_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          suppressed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_mailbox_session ON subagent_parent_mailbox(parent_session_id, status);
        CREATE INDEX IF NOT EXISTS idx_subagent_mailbox_retry ON subagent_parent_mailbox(status, next_retry_at);

        CREATE TABLE IF NOT EXISTS subagent_workspace_leases (
          canonical_workspace TEXT PRIMARY KEY NOT NULL,
          lease_kind TEXT NOT NULL CHECK (lease_kind IN ('subagent_write','parent_write')),
          owner_kind TEXT NOT NULL CHECK (owner_kind IN ('subagent','parent_agent','system')),
          owner_id TEXT NOT NULL,
          boot_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_leases_expiry ON subagent_workspace_leases(expires_at);
      `);

      // observability 查询列（§19.1）：activity_events 已有 subagent_run_id（v8），
      // 补齐 subagent_thread_id；audit_events 两者都缺。判重后 ALTER + 索引。
      const activityColumns = database.prepare("PRAGMA table_info(activity_events)").all() as Array<{ name: string }>;
      if (!activityColumns.some((column) => column.name === "subagent_thread_id")) {
        database.exec("ALTER TABLE activity_events ADD COLUMN subagent_thread_id TEXT");
      }
      const auditColumns = database.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
      if (!auditColumns.some((column) => column.name === "subagent_thread_id")) {
        database.exec("ALTER TABLE audit_events ADD COLUMN subagent_thread_id TEXT");
      }
      if (!auditColumns.some((column) => column.name === "subagent_run_id")) {
        database.exec("ALTER TABLE audit_events ADD COLUMN subagent_run_id TEXT");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_subagent_thread ON activity_events(subagent_thread_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_subagent_thread ON audit_events(subagent_thread_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_subagent_run ON audit_events(subagent_run_id, recorded_at DESC);
      `);

      database.prepare("UPDATE schema_version SET version = 12").run();
    })();
  }

  if (current < 13) {
    // T14：memory_journal.actor 放开 'background_review'（后台复盘产出的意图）。
    // SQLite CHECK 约束不可 ALTER，走标准表重建：建新表 → 拷贝 → 换名 → 重建索引。
    database.exec(`
      CREATE TABLE memory_journal_v13 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('user','main_agent','memory_agent','system','background_review')),
        intent_type TEXT NOT NULL CHECK (intent_type IN ('remember','forget','pin','unpin','supersede','merge','suppress','restore')),
        target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session','memory')),
        target_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','applied','revoked')),
        created_at TEXT NOT NULL,
        applied_at TEXT,
        priority INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO memory_journal_v13
        SELECT id, agent_id, actor, intent_type, target_type, target_id, payload, status, created_at, applied_at, priority
        FROM memory_journal;
      DROP TABLE memory_journal;
      ALTER TABLE memory_journal_v13 RENAME TO memory_journal;
      CREATE INDEX IF NOT EXISTS idx_memory_journal_agent_status ON memory_journal(agent_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_journal_agent_priority ON memory_journal(agent_id, priority, status, created_at);
    `);
    database.prepare("UPDATE schema_version SET version = 13").run();
  }

  // v14：波次 A8 统一模型用量（plans/p1-quality-model-usage.en.md A8 节）。
  // usage_records 重建为跨来源账目表：source（main/subagent/utility）、role
  // （primary/secondary）、status 终态、agent/thread/run/call 关联与起止时间。
  // session_id/turn_id 放宽为可空：utility 全局调用（如每日记忆整理）无会话归属。
  // 幂等键改为 dedupe_key UNIQUE：main = `${sessionId}:${turnId}`，subagent =
  // `run:${runId}`，utility = `call:${callId}`，跨来源不再共挤一个键空间。
  // 存量行即主会话成功 turn，按 source=main / role=primary / status=completed
  // 回填；agent/thread/run/call 对存量行不可恢复（旧记录未携带），保持 NULL =
  // 未知，不做猜测回填。
  if (current < 14) {
    database.exec(`
      CREATE TABLE usage_records_v14 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        turn_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER,
        context_window INTEGER,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'main'
          CHECK (source IN ('main','subagent','utility')),
        role TEXT NOT NULL DEFAULT 'primary'
          CHECK (role IN ('primary','secondary')),
        status TEXT NOT NULL DEFAULT 'completed'
          CHECK (status IN ('completed','failed','cancelled','timeout','interrupted','budget_exhausted')),
        agent_id TEXT,
        thread_id TEXT,
        run_id TEXT,
        call_id TEXT,
        started_at TEXT,
        finished_at TEXT,
        dedupe_key TEXT NOT NULL UNIQUE
      );
      INSERT INTO usage_records_v14
        (id, session_id, turn_id, provider, model, input, output, cache_read, cache_write,
         total_tokens, context_tokens, context_window, created_at, source, role, status,
         agent_id, thread_id, run_id, call_id, started_at, finished_at, dedupe_key)
        SELECT
          id, session_id, turn_id, provider, model, input, output, cache_read, cache_write,
          total_tokens, context_tokens, context_window, created_at, 'main', 'primary', 'completed',
          NULL, NULL, NULL, NULL, NULL, NULL,
          session_id || ':' || turn_id
        FROM usage_records;
      DROP TABLE usage_records;
      ALTER TABLE usage_records_v14 RENAME TO usage_records;

      CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
        ON usage_records (created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_source_time
        ON usage_records (source, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_agent_time
        ON usage_records (agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_role_time
        ON usage_records (role, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_session_time
        ON usage_records (session_id, created_at);
    `);
    database.prepare("UPDATE schema_version SET version = 14").run();
  }

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 metadata schema 版本: ${current}`);
  }

  if (current < CURRENT_SCHEMA_VERSION) {
    observer?.({ from: current, to: CURRENT_SCHEMA_VERSION });
  }
}
