import type Database from "better-sqlite3";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：Activity/Audit 查询层（plans/phase-11.md §十）
//
// - cursor 分页：固定 recorded_at DESC, id DESC；cursor = {recordedAt, id}，
//   避免相同时间戳重复或漏项（gap 允许：retention 删除后从下一条继续）；
// - FTS：activity_events_fts MATCH（search_text 为英文机器标识为主），
//   CJK 查询回退 LIKE（unicode61 tokenizer 不切中文）；
// - trace tree：同 traceId 行按 spanId/parentSpanId 重构 span 树；
// - linked graph：observability_trace_links 双向查询，bounded
//   （maxDepth/maxNodes，响应含 truncated 标记）；
// - 错误分组：按 event_name + error_code 聚合计数/最近时间；
// - 派生指标：按日聚合（live 计算，T9 retention 前落 activity_daily_metrics）。
// ═══════════════════════════════════════════════════════════════

export interface ActivityFilter {
  readonly from?: string;
  readonly to?: string;
  readonly ownerAgentId?: string;
  readonly sessionId?: string;
  readonly eventName?: string;
  readonly category?: string;
  readonly level?: string;
  readonly status?: string;
  readonly significance?: string;
  readonly component?: string;
  readonly errorCode?: string;
  readonly traceId?: string;
  readonly operationId?: string;
  readonly search?: string;
}

export interface PageCursor {
  readonly recordedAt: string;
  readonly id: number;
}

export interface PagedResult<T> {
  readonly items: T[];
  /** 下一页 cursor；无更多数据时为 null */
  readonly nextCursor: PageCursor | null;
}

export interface ActivityRow {
  readonly id: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly eventName: string;
  readonly category: string;
  readonly level: string;
  readonly status: string | null;
  readonly significance: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly executorKind: string;
  readonly executorId: string;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly ownerAgentId: string | null;
  readonly sessionId: string | null;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly operationId: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly retryable: number;
  readonly producerComponent: string;
  readonly producerProcessType: string;
  readonly payloadJson: string;
}

export interface AuditRow {
  readonly id: number;
  readonly eventId: string;
  readonly ledgerEpoch: number;
  readonly recordedAt: string;
  readonly action: string;
  readonly decision: string;
  readonly reasonCode: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly ownerAgentId: string | null;
  readonly sessionId: string | null;
  readonly traceId: string;
  readonly payloadJson: string;
}

export interface TraceSpan {
  readonly id: number;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  /** 合并后的事件名（started 行在前；有终态行时取终态事件名） */
  eventName: string;
  status: string | null;
  readonly recordedAt: string;
  durationMs: number | null;
  readonly operationId: string | null;
  readonly children: TraceSpan[];
}

export interface LinkedGraphNode {
  readonly traceId: string;
  readonly relation: string;
  readonly direction: "forward" | "reverse";
}

export interface LinkedGraph {
  readonly rootTraceId: string;
  readonly nodes: LinkedGraphNode[];
  readonly truncated: boolean;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface ErrorGroup {
  readonly eventName: string;
  readonly errorCode: string | null;
  readonly count: number;
  readonly lastRecordedAt: string;
}

export interface DailyMetric {
  readonly date: string;
  readonly eventCount: number;
  readonly errorCount: number;
  readonly failedCount: number;
  readonly degradedCount: number;
  readonly byLevel: Record<string, number>;
}

interface MutableDailyMetric {
  date: string;
  eventCount: number;
  errorCount: number;
  failedCount: number;
  degradedCount: number;
  byLevel: Record<string, number>;
}

export interface TraceTreeResult {
  readonly root: TraceSpan | null;
  readonly total: number;
}

const ACTIVITY_COLUMNS = `
  id, event_id AS eventId, recorded_at AS recordedAt, occurred_at AS occurredAt,
  event_name AS eventName, category, level, status, significance,
  actor_kind AS actorKind, actor_id AS actorId,
  executor_kind AS executorKind, executor_id AS executorId,
  target_kind AS targetKind, target_id AS targetId,
  owner_agent_id AS ownerAgentId, session_id AS sessionId,
  trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId,
  operation_id AS operationId, duration_ms AS durationMs,
  error_code AS errorCode, retryable,
  producer_component AS producerComponent, producer_process_type AS producerProcessType,
  payload_json AS payloadJson`;

const AUDIT_COLUMNS = `
  id, event_id AS eventId, ledger_epoch AS ledgerEpoch, recorded_at AS recordedAt,
  action, decision, reason_code AS reasonCode,
  actor_kind AS actorKind, actor_id AS actorId,
  owner_agent_id AS ownerAgentId, session_id AS sessionId,
  trace_id AS traceId, payload_json AS payloadJson`;

const MAX_PAGE_SIZE = 200;
const MAX_TRACE_NODES = 200;
const MAX_TRACE_DEPTH = 16;

export class ObservabilityQuery {
  constructor(private readonly database: Database.Database) {}

  // ─── Activity cursor 分页 ─────────────────────────────────────

  queryActivities(
    filter: ActivityFilter,
    cursor: PageCursor | null,
    limit = 50,
  ): PagedResult<ActivityRow> {
    const size = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from !== undefined) { where.push("recorded_at >= ?"); params.push(filter.from); }
    if (filter.to !== undefined) { where.push("recorded_at <= ?"); params.push(filter.to); }
    if (filter.ownerAgentId !== undefined) { where.push("owner_agent_id = ?"); params.push(filter.ownerAgentId); }
    if (filter.sessionId !== undefined) { where.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.eventName !== undefined) { where.push("event_name = ?"); params.push(filter.eventName); }
    if (filter.category !== undefined) { where.push("category = ?"); params.push(filter.category); }
    if (filter.level !== undefined) { where.push("level = ?"); params.push(filter.level); }
    if (filter.status !== undefined) { where.push("status = ?"); params.push(filter.status); }
    if (filter.significance !== undefined) { where.push("significance = ?"); params.push(filter.significance); }
    if (filter.component !== undefined) { where.push("producer_component = ?"); params.push(filter.component); }
    if (filter.errorCode !== undefined) { where.push("error_code = ?"); params.push(filter.errorCode); }
    if (filter.traceId !== undefined) { where.push("trace_id = ?"); params.push(filter.traceId); }
    if (filter.operationId !== undefined) { where.push("operation_id = ?"); params.push(filter.operationId); }
    // cursor：recorded_at DESC, id DESC → 定位到 (recordedAt, id) 之前的记录
    if (cursor !== null) {
      where.push("(recorded_at < ? OR (recorded_at = ? AND id < ?))");
      params.push(cursor.recordedAt, cursor.recordedAt, cursor.id);
    }
    let searchWhere = "";
    const searchParams: unknown[] = [];
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim();
      if (/[\u4e00-\u9fff]/.test(query)) {
        // CJK：unicode61 FTS 不切中文 → LIKE 回退（search_text 为英文标识为主）
        searchWhere = " AND (event_name LIKE ? OR category LIKE ? OR search_text LIKE ?)";
        const like = `%${query}%`;
        searchParams.push(like, like, like);
      } else {
        // FTS5 语法安全化：按非字母数字切词 → 引号包裹 AND 语义
        // （"turn.completed" 中的 "." 是 FTS 语法字符，直接 MATCH 会抛错）
        const terms = query.split(/[^a-zA-Z0-9_]+/).filter((term) => term.length > 0)
          .map((term) => `"${term.replace(/"/g, "")}"`);
        if (terms.length === 0) {
          searchWhere = " AND 0";
        } else {
          searchWhere = " AND id IN (SELECT rowid FROM activity_events_fts WHERE activity_events_fts MATCH ?)";
          searchParams.push(terms.join(" "));
        }
      }
    }
    const rows = this.database
      .prepare(
        `SELECT ${ACTIVITY_COLUMNS} FROM activity_events
         WHERE ${where.length > 0 ? where.join(" AND ") : "1=1"}${searchWhere}
         ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, ...searchParams, size + 1) as ActivityRow[];
    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    return {
      items: page,
      nextCursor: hasMore ? this.cursorOf(page[page.length - 1]!) : null,
    };
  }

  getActivity(eventId: string): ActivityRow | null {
    return (this.database
      .prepare(`SELECT ${ACTIVITY_COLUMNS} FROM activity_events WHERE event_id = ?`)
      .get(eventId) as ActivityRow | undefined) ?? null;
  }

  /** 按表 id 从 afterId 之后取（SSE/高水位交接用；允许 gap） */
  listActivityAfterId(afterId: number, limit = 200): ActivityRow[] {
    return this.database
      .prepare(`SELECT ${ACTIVITY_COLUMNS} FROM activity_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE)) as ActivityRow[];
  }

  maxActivityId(): number {
    return (this.database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM activity_events").get() as { maxId: number }).maxId;
  }

  // ─── Audit cursor 分页 ────────────────────────────────────────

  queryAudit(
    filter: { epoch?: number; action?: string; decision?: string; ownerAgentId?: string; sessionId?: string; traceId?: string },
    cursor: PageCursor | null,
    limit = 50,
  ): PagedResult<AuditRow> {
    const size = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.epoch !== undefined) { where.push("ledger_epoch = ?"); params.push(filter.epoch); }
    if (filter.action !== undefined) { where.push("action = ?"); params.push(filter.action); }
    if (filter.decision !== undefined) { where.push("decision = ?"); params.push(filter.decision); }
    if (filter.ownerAgentId !== undefined) { where.push("owner_agent_id = ?"); params.push(filter.ownerAgentId); }
    if (filter.sessionId !== undefined) { where.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.traceId !== undefined) { where.push("trace_id = ?"); params.push(filter.traceId); }
    if (cursor !== null) {
      where.push("(recorded_at < ? OR (recorded_at = ? AND id < ?))");
      params.push(cursor.recordedAt, cursor.recordedAt, cursor.id);
    }
    const rows = this.database
      .prepare(
        `SELECT ${AUDIT_COLUMNS} FROM audit_events
         WHERE ${where.length > 0 ? where.join(" AND ") : "1=1"}
         ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, size + 1) as AuditRow[];
    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    return {
      items: page,
      nextCursor: hasMore ? this.cursorOf(page[page.length - 1]!) : null,
    };
  }

  /** 按表 id 从 afterId 之后取（audit SSE/高水位交接用） */
  listAuditAfterId(afterId: number, limit = 200): AuditRow[] {
    return this.database
      .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE)) as AuditRow[];
  }

  maxAuditId(): number {
    return (this.database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM audit_events").get() as { maxId: number }).maxId;
  }

  // ─── trace tree / linked graph ────────────────────────────────

  /**
   * trace tree（评审 P1-6）：lifecycle 的 started 与 terminal 共享同一 spanId，
   * 原实现 Map<spanId, row> 后写覆盖先写——terminal 行会清空已挂好的子 span，
   * 真实 Turn 树只剩根节点。修复：按 spanId 合并，started 作节点基底，
   * terminal 行把 status/eventName/durationMs 合并进同一节点。
   */
  traceTree(traceId: string): TraceTreeResult {
    const rows = this.database
      .prepare(
        `SELECT id, span_id AS spanId, parent_span_id AS parentSpanId, event_name AS eventName,
                status, recorded_at AS recordedAt, duration_ms AS durationMs, operation_id AS operationId
         FROM activity_events WHERE trace_id = ? ORDER BY id ASC`,
      )
      .all(traceId) as Array<{
        id: number; spanId: string; parentSpanId: string | null; eventName: string;
        status: string | null; recordedAt: string; durationMs: number | null; operationId: string | null;
      }>;
    if (rows.length === 0) return { root: null, total: 0 };
    const bySpanId = new Map<string, TraceSpan>();
    for (const row of rows) {
      const existing = bySpanId.get(row.spanId);
      if (existing !== undefined) {
        // 同 span 的 started+terminal 行：终态语义覆盖 started 的占位字段
        if (row.status !== "started") {
          existing.eventName = row.eventName;
          existing.status = row.status;
          existing.durationMs = row.durationMs;
        }
        continue;
      }
      bySpanId.set(row.spanId, { ...row, children: [] });
    }
    const roots: TraceSpan[] = [];
    for (const span of bySpanId.values()) {
      const parent = span.parentSpanId !== null ? bySpanId.get(span.parentSpanId) : undefined;
      if (parent !== undefined && parent !== span) {
        parent.children.push(span);
      } else {
        roots.push(span);
      }
    }
    // 按时间升序排子 span，保证确定性
    const sortTree = (span: TraceSpan): void => {
      span.children.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
      for (const child of span.children) sortTree(child);
    };
    for (const root of roots) sortTree(root);
    const root = roots.length > 0 ? roots[0]! : null;
    return { root, total: rows.length };
  }

  linkedGraph(traceId: string, options: { maxDepth?: number; maxNodes?: number } = {}): LinkedGraph {
    const maxNodes = Math.min(options.maxNodes ?? 50, MAX_TRACE_NODES);
    const maxDepth = Math.min(options.maxDepth ?? 4, MAX_TRACE_DEPTH);
    const nodes: LinkedGraphNode[] = [];
    const seen = new Set<string>([traceId]);
    // BFS 双向遍历：forward = source→target；reverse = target→source（逆向查找）
    let frontier = [traceId];
    let depth = 0;
    let truncated = false;
    while (frontier.length > 0 && depth < maxDepth && nodes.length < maxNodes) {
      const next: string[] = [];
      for (const current of frontier) {
        const forward = this.database
          .prepare("SELECT target_trace_id AS traceId, relation FROM observability_trace_links WHERE source_trace_id = ?")
          .all(current) as Array<{ traceId: string; relation: string }>;
        const reverse = this.database
          .prepare("SELECT source_trace_id AS traceId, relation FROM observability_trace_links WHERE target_trace_id = ?")
          .all(current) as Array<{ traceId: string; relation: string }>;
        for (const link of forward) {
          if (seen.has(link.traceId)) continue;
          if (nodes.length >= maxNodes) { truncated = true; break; }
          seen.add(link.traceId);
          nodes.push({ traceId: link.traceId, relation: link.relation, direction: "forward" });
          next.push(link.traceId);
        }
        for (const link of reverse) {
          if (seen.has(link.traceId)) continue;
          if (nodes.length >= maxNodes) { truncated = true; break; }
          seen.add(link.traceId);
          nodes.push({ traceId: link.traceId, relation: link.relation, direction: "reverse" });
          next.push(link.traceId);
        }
      }
      frontier = next;
      depth += 1;
    }
    if (frontier.length > 0 && depth >= maxDepth) truncated = true;
    return { rootTraceId: traceId, nodes, truncated, maxDepth, maxNodes };
  }

  // ─── 错误分组 / 派生指标 ──────────────────────────────────────

  errorGroups(filter: { since?: string; eventName?: string; limit?: number } = {}): ErrorGroup[] {
    // 评审 P1-11：条件组必须加括号，否则 AND 优先级会让旧 error/fatal
    // 绕过 since/eventName 过滤
    const where: string[] = ["(level IN ('error', 'fatal') OR status IN ('failed', 'denied'))"];
    const params: unknown[] = [];
    if (filter.since !== undefined) { where.push("recorded_at >= ?"); params.push(filter.since); }
    if (filter.eventName !== undefined) { where.push("event_name = ?"); params.push(filter.eventName); }
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
    return this.database
      .prepare(
        `SELECT event_name AS eventName, error_code AS errorCode, COUNT(*) AS count, MAX(recorded_at) AS lastRecordedAt
         FROM activity_events WHERE ${where.join(" AND ")}
         GROUP BY event_name, error_code ORDER BY count DESC LIMIT ?`,
      )
      .all(...params, limit) as ErrorGroup[];
  }

  /**
   * 派生指标（评审 P1-5）：retention 把已聚合的 Activity 落 activity_daily_metrics
   * 后删除——此处必须读聚合表，而不是只读尚未删除的 activity_events。
   * 口径：聚合表（watermark 之前全部已聚合）+ 实时表（watermark 之后未聚合，
   * 按 watermark 日期分界避免与聚合表重复计数；从未跑过 retention 时全部走实时表）。
   */
  dailyMetrics(filter: { since?: string; ownerAgentId?: string; days?: number } = {}): DailyMetric[] {
    const days = Math.min(Math.max(1, Math.floor(filter.days ?? 30)), 365);
    const since = filter.since ?? new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const sinceDate = since.slice(0, 10);
    const watermark = (this.database
      .prepare("SELECT value FROM observability_state WHERE key = 'observability.retention.watermark'")
      .get() as { value: string } | undefined)?.value ?? "";
    const byDate = new Map<string, MutableDailyMetric>();
    const mergeRow = (date: string, level: string, status: string | null, count: number): void => {
      const metric = byDate.get(date) ?? {
        date, eventCount: 0, errorCount: 0, failedCount: 0, degradedCount: 0, byLevel: {},
      };
      metric.eventCount += count;
      metric.byLevel[level] = (metric.byLevel[level] ?? 0) + count;
      if (level === "error" || level === "fatal") metric.errorCount += count;
      if (status === "failed") metric.failedCount += count;
      if (status === "degraded") metric.degradedCount += count;
      byDate.set(date, metric);
    };
    // 1) 聚合表（retention 已落库的部分）
    const aggParams: unknown[] = [sinceDate];
    let aggWhere = "metric_date >= ?";
    if (filter.ownerAgentId !== undefined) {
      aggWhere += " AND owner_agent_id = ?";
      aggParams.push(filter.ownerAgentId);
    }
    const aggRows = this.database
      .prepare(
        `SELECT metric_date AS date, value_json AS valueJson FROM activity_daily_metrics
         WHERE ${aggWhere}`,
      )
      .all(...aggParams) as Array<{ date: string; valueJson: string }>;
    for (const row of aggRows) {
      const value = JSON.parse(row.valueJson) as { count?: unknown; level?: unknown; status?: unknown };
      const count = typeof value.count === "number" ? value.count : 0;
      mergeRow(row.date, typeof value.level === "string" ? value.level : "info", typeof value.status === "string" ? value.status : null, count);
    }
    // 2) 实时表（watermark 之后未聚合；无 watermark 时全量）
    const liveParams: unknown[] = [since];
    const liveWhere: string[] = ["recorded_at >= ?"];
    if (watermark !== "" && watermark > sinceDate) {
      liveWhere.push("substr(recorded_at, 1, 10) >= ?");
      liveParams.push(watermark);
    }
    if (filter.ownerAgentId !== undefined) {
      liveWhere.push("owner_agent_id = ?");
      liveParams.push(filter.ownerAgentId);
    }
    const liveRows = this.database
      .prepare(
        `SELECT substr(recorded_at, 1, 10) AS date, level, status, COUNT(*) AS count
         FROM activity_events WHERE ${liveWhere.join(" AND ")}
         GROUP BY substr(recorded_at, 1, 10), level, status`,
      )
      .all(...liveParams) as Array<{ date: string; level: string; status: string | null; count: number }>;
    for (const row of liveRows) {
      mergeRow(row.date, row.level, row.status, row.count);
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  private cursorOf(row: { recordedAt: string; id: number }): PageCursor {
    return { recordedAt: row.recordedAt, id: row.id };
  }
}
