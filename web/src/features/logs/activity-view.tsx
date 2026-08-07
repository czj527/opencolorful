import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { ActivityQuery, ActivityRow, TraceResponse, TraceSpan } from "../../lib/types.js";
import { Badge, Button, EmptyState, Select, Spinner, TextField, Toggle } from "../../components/ui/index.js";
import { formatTime, parsePayload, payloadPreview } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface ActivityViewProps {
  readonly api: ApiClient;
  /** URL 预筛选初始值（如 /logs?plugin=<pluginId>），填入「全文搜索」并作为初始过滤条件 */
  readonly initialSearch?: string;
  /** P1-3：插件预筛选（/logs?plugin=<pluginId>）——按 plugin_id 独立过滤，而非全文搜索 */
  readonly initialPluginId?: string;
  /** T7：Skill 预筛选（/logs?skill=<skillRefKey>）——按 skillRefKey 独立过滤，仿 plugin 模式 */
  readonly initialSkillRefKey?: string;
  /** Phase 14（§19.5）：Subagent 预筛选（/logs?subagent=<threadId>）——按 subagent_thread_id 独立过滤 */
  readonly initialSubagentThreadId?: string;
}

const CATEGORY_OPTIONS = [
  "system", "supervisor", "storage", "agent", "session", "turn", "model", "provider",
  "tool", "sandbox", "memory", "api", "connection", "client", "plugin", "observability", "audit",
] as const;

const LEVEL_OPTIONS = ["error", "warn", "info", "debug", "trace", "fatal"] as const;

const STATUS_OPTIONS = [
  "started", "processing", "completed", "degraded", "failed", "cancelled",
  "denied", "deferred", "retrying", "skipped", "interrupted",
] as const;

const PAGE_SIZE = 50;

interface DraftFilter {
  readonly eventName: string;
  readonly category: string;
  readonly level: string;
  readonly status: string;
  readonly sessionId: string;
  readonly ownerAgentId: string;
  readonly pluginId: string;
  readonly skillRefKey: string;
  readonly subagentThreadId: string;
  readonly search: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_DRAFT: DraftFilter = {
  eventName: "",
  category: "",
  level: "",
  status: "",
  sessionId: "",
  ownerAgentId: "",
  pluginId: "",
  skillRefKey: "",
  subagentThreadId: "",
  search: "",
  from: "",
  to: "",
};

function buildQuery(draft: DraftFilter): ActivityQuery {
  const filter: ActivityQuery = {
    ...(draft.eventName.trim() !== "" ? { eventName: draft.eventName.trim() } : {}),
    ...(draft.category !== "" ? { category: draft.category } : {}),
    ...(draft.level !== "" ? { level: draft.level } : {}),
    ...(draft.status !== "" ? { status: draft.status } : {}),
    ...(draft.sessionId.trim() !== "" ? { sessionId: draft.sessionId.trim() } : {}),
    ...(draft.ownerAgentId.trim() !== "" ? { ownerAgentId: draft.ownerAgentId.trim() } : {}),
    ...(draft.pluginId.trim() !== "" ? { pluginId: draft.pluginId.trim() } : {}),
    ...(draft.skillRefKey.trim() !== "" ? { skillRefKey: draft.skillRefKey.trim() } : {}),
    ...(draft.subagentThreadId.trim() !== "" ? { subagentThreadId: draft.subagentThreadId.trim() } : {}),
    ...(draft.search.trim() !== "" ? { search: draft.search.trim() } : {}),
    ...(draft.from !== "" ? { from: draft.from } : {}),
    ...(draft.to !== "" ? { to: draft.to } : {}),
  };
  return filter;
}

/**
 * 评审 P1-11：实时跟随必须应用当前活动筛选——SSE 流是全局的，
 * 客户端按 applied 过滤后再进入列表，否则筛选条件下 live 行会混入。
 */
function matchesAppliedFilter(row: ActivityRow, filter: ActivityQuery): boolean {
  if (filter.eventName !== undefined && row.eventName !== filter.eventName) return false;
  if (filter.category !== undefined && row.category !== filter.category) return false;
  if (filter.level !== undefined && row.level !== filter.level) return false;
  if (filter.status !== undefined && row.status !== filter.status) return false;
  if (filter.sessionId !== undefined && row.sessionId !== filter.sessionId) return false;
  if (filter.ownerAgentId !== undefined && row.ownerAgentId !== filter.ownerAgentId) return false;
  if (filter.pluginId !== undefined && row.pluginId !== filter.pluginId) return false;
  // Phase 14（§19.5）：subagent 过滤——subagent_thread_id 列精确匹配（服务端同语义）
  if (filter.subagentThreadId !== undefined && filter.subagentThreadId.trim() !== ""
    && row.subagentThreadId !== filter.subagentThreadId.trim()) {
    return false;
  }
  // T7：skill 过滤——payload attributes.skillRefKey 精确匹配（服务端同语义）
  if (filter.skillRefKey !== undefined && filter.skillRefKey.trim() !== "") {
    const parsed = parsePayload(row.payloadJson);
    const attributes = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["attributes"]
      : undefined;
    const actual = typeof attributes === "object" && attributes !== null
      ? String((attributes as Record<string, unknown>)["skillRefKey"] ?? "")
      : "";
    if (actual !== filter.skillRefKey.trim()) return false;
  }
  if (filter.search !== undefined && filter.search.trim() !== "") {
    const term = filter.search.trim();
    if (!row.eventName.includes(term) && !row.category.includes(term)) return false;
  }
  if (filter.from !== undefined && row.recordedAt < filter.from) return false;
  if (filter.to !== undefined && row.recordedAt > filter.to) return false;
  return true;
}

export function ActivityView({ api, initialSearch = "", initialPluginId = "", initialSkillRefKey = "", initialSubagentThreadId = "" }: ActivityViewProps) {
  // 预筛选（?plugin= / ?skill= / ?subagent= 等）：初始 draft 与 applied 都带预筛选值，
  // 使首次加载即按该条件过滤；无预筛选时与之前行为一致
  const [draft, setDraft] = useState<DraftFilter>(() => ({ ...EMPTY_DRAFT, search: initialSearch, pluginId: initialPluginId, skillRefKey: initialSkillRefKey, subagentThreadId: initialSubagentThreadId }));
  // 初始 applied 为空过滤（buildQuery 过滤空串），避免把空串参数发给后端导致零匹配
  const [applied, setApplied] = useState<ActivityQuery>(() => buildQuery({ ...EMPTY_DRAFT, search: initialSearch, pluginId: initialPluginId, skillRefKey: initialSkillRefKey, subagentThreadId: initialSubagentThreadId }));
  const [items, setItems] = useState<readonly ActivityRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ActivityRow | null>(null);
  const [following, setFollowing] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [followCount, setFollowCount] = useState(0);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const sinceIdRef = useRef(0);
  // 评审 P1-11：follow 连接按开启瞬间固定，筛选变化不重建连接——
  // 用 ref 镜像 applied 供事件处理器读取
  const appliedRef = useRef(applied);
  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  const patchDraft = useCallback(<K extends keyof DraftFilter>(key: K, value: DraftFilter[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const load = useCallback(async (cursor: string | null) => {
    if (cursor === null) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const page = await api.queryActivity(applied, cursor, PAGE_SIZE);
      if (cursor === null) {
        setItems(page.items);
      } else {
        // 与 live follow 到达的新行去重，避免重复
        setItems((current) => {
          const known = new Set(current.map((row) => row.id));
          return [...current, ...page.items.filter((row) => !known.has(row.id))];
        });
      }
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "活动事件加载失败");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [api, applied]);

  useEffect(() => {
    void load(null);
  }, [load]);

  // live follow：EventSource 订阅 /api/observability/activity/stream，新行 prepend 到列表顶部
  useEffect(() => {
    if (!following) return undefined;
    if (typeof EventSource === "undefined") {
      setError("当前环境不支持实时跟随（EventSource 不可用）");
      setFollowing(false);
      return undefined;
    }
    const maxId = items.reduce((max, row) => Math.max(max, row.id), 0);
    sinceIdRef.current = maxId;
    setFollowOpen(false);
    setFollowCount(0);
    const es = new EventSource(`/api/observability/activity/stream?sinceId=${maxId}`);
    es.addEventListener("open", () => setFollowOpen(true));
    es.addEventListener("activity", (event) => {
      try {
        const row = JSON.parse((event as MessageEvent).data) as ActivityRow;
        if (typeof row.id !== "number") return;
        // 评审 P1-11：live 行必须匹配当前 applied 筛选（SSE 流为全局流）
        if (!matchesAppliedFilter(row, appliedRef.current)) return;
        sinceIdRef.current = Math.max(sinceIdRef.current, row.id);
        setItems((current) => {
          if (current.some((existing) => existing.id === row.id)) return current;
          return [row, ...current];
        });
        setFollowCount((count) => count + 1);
      } catch {
        /* 忽略无法解析的行 */
      }
    });
    es.addEventListener("reset", () => {
      setResetNote("游标已重置：实时流起点已变化，如需完整数据请重新加载。");
    });
    es.addEventListener("error", () => {
      /* EventSource 断线会自动重连，无需处理 */
    });
    esRef.current = es;
    return () => {
      es.close();
      esRef.current = null;
      setFollowOpen(false);
    };
    // items 变化不重建连接：sinceId 在开启瞬间固定，避免重放已加载行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following]);

  const handleApply = useCallback(() => {
    setApplied(buildQuery(draft));
    setItems([]);
    setNextCursor(null);
    setSelected(null);
  }, [draft]);

  const handleReset = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setItems([]);
    setNextCursor(null);
    setSelected(null);
  }, []);

  const toggleFollow = useCallback((on: boolean) => {
    setResetNote(null);
    setFollowing(on);
    if (!on) {
      esRef.current?.close();
      esRef.current = null;
      setFollowOpen(false);
    }
  }, []);

  const statusBadge = (status: string | null): ReactNode => {
    if (status === null) return <Badge variant="default">—</Badge>;
    const variant = status === "failed" || status === "denied"
      ? "danger"
      : status === "degraded" || status === "cancelled" || status === "interrupted"
        ? "warning"
        : "success";
    return <Badge variant={variant}>{status}</Badge>;
  };

  return (
    <section className={styles.tabPane} aria-label="活动事件">
      <div className={styles.filterBar} data-testid="activity-filter-bar">
        <TextField
          value={draft.eventName}
          onChange={(value) => patchDraft("eventName", value)}
          placeholder="事件名（如 system.started）"
          aria-label="事件名过滤"
          className={styles.filterEvent ?? ""}
        />
        <Select value={draft.category} onChange={(value) => patchDraft("category", value)} aria-label="类别过滤">
          <option value="">全部类别</option>
          {CATEGORY_OPTIONS.map((category) => <option key={category} value={category}>{category}</option>)}
        </Select>
        <Select value={draft.level} onChange={(value) => patchDraft("level", value)} aria-label="级别过滤">
          <option value="">全部级别</option>
          {LEVEL_OPTIONS.map((level) => <option key={level} value={level}>{level}</option>)}
        </Select>
        <Select value={draft.status} onChange={(value) => patchDraft("status", value)} aria-label="状态过滤">
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
        </Select>
        <TextField
          value={draft.sessionId}
          onChange={(value) => patchDraft("sessionId", value)}
          placeholder="Session ID"
          aria-label="Session ID 过滤"
          className={styles.filterId ?? ""}
        />
        <TextField
          value={draft.ownerAgentId}
          onChange={(value) => patchDraft("ownerAgentId", value)}
          placeholder="Agent ID"
          aria-label="Agent ID 过滤"
          className={styles.filterId ?? ""}
        />
        <TextField
          value={draft.search}
          onChange={(value) => patchDraft("search", value)}
          placeholder="全文搜索"
          aria-label="全文搜索"
          className={styles.filterId ?? ""}
        />
        <label className={styles.filterDate}>
          从
          <input
            type="date"
            value={draft.from}
            onChange={(event) => patchDraft("from", event.target.value)}
            aria-label="起始日期"
          />
        </label>
        <label className={styles.filterDate}>
          至
          <input
            type="date"
            value={draft.to}
            onChange={(event) => patchDraft("to", event.target.value)}
            aria-label="结束日期"
          />
        </label>
        <Button size="sm" onClick={handleApply}>应用过滤</Button>
        <Button variant="ghost" size="sm" onClick={handleReset}>重置</Button>
      </div>

      <div className={styles.followRow}>
        <Toggle
          id="activity-follow"
          label="实时跟随"
          checked={following}
          onChange={toggleFollow}
        />
        {followOpen && <Badge variant="success" className={styles.followBadge ?? ""}>跟随中{followCount > 0 ? `（+${followCount}）` : ""}</Badge>}
        {resetNote !== null && (
          <span className={styles.resetNote} role="status">
            {resetNote}
            <Button variant="ghost" size="sm" onClick={() => setResetNote(null)}>关闭</Button>
          </span>
        )}
      </div>

      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <Button size="sm" onClick={() => void load(null)}><RefreshCw size={14} /> 重试</Button>
        </div>
      )}

      {loading ? (
        <div className={styles.loadingRow}><Spinner /> 正在加载活动事件…</div>
      ) : items.length === 0 && error === null ? (
        <EmptyState
          title="暂无活动事件"
          description="调整过滤条件或稍后再试；开启实时跟随可即时看到新事件。"
        />
      ) : items.length === 0 ? null : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th className={styles.colLevel}>级别</th>
                  <th>状态</th>
                  <th className={styles.colCategory}>类别</th>
                  <th className={styles.colComponent}>组件</th>
                  <th className={styles.colDuration}>时长</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`activity-row-${row.id}`}
                    className={selected?.id === row.id ? styles.rowActive : undefined}
                    onClick={() => setSelected(selected?.id === row.id ? null : row)}
                  >
                    <td className={styles.colTime}>{formatTime(row.recordedAt)}</td>
                    <td><span className={styles.eventName}>{row.eventName}</span></td>
                    <td className={styles.colLevel}>{row.level}</td>
                    <td>{statusBadge(row.status)}</td>
                    <td className={styles.colCategory}>{row.category}</td>
                    <td className={styles.colComponent}><code className={styles.codeInline}>{row.producerComponent}</code></td>
                    <td className={styles.colDuration}>{row.durationMs !== null ? `${row.durationMs} ms` : "—"}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.rowAction}
                        aria-label={`查看 ${row.eventName} 详情`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected(selected?.id === row.id ? null : row);
                        }}
                      >
                        {selected?.id === row.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor !== null && (
            <div className={styles.loadMoreRow}>
              <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void load(nextCursor)}>
                加载更多
              </Button>
            </div>
          )}
        </>
      )}

      {selected !== null && (
        <ActivityDetail
          api={api}
          row={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

// ─── 详情面板 ─────────────────────────────────────────────────

interface ActivityDetailProps {
  readonly api: ApiClient;
  readonly row: ActivityRow;
  readonly onClose: () => void;
}

function ActivityDetail({ api, row, onClose }: ActivityDetailProps) {
  const [showFullPayload, setShowFullPayload] = useState(false);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const payload = parsePayload(row.payloadJson);
  const preview = payloadPreview(payload);

  const loadTrace = useCallback(async () => {
    if (row.traceId === "") return;
    setTraceLoading(true);
    setTraceError(null);
    try {
      setTrace(await api.getTrace(row.traceId, true));
    } catch (cause) {
      setTraceError(cause instanceof Error ? cause.message : "trace 加载失败");
    } finally {
      setTraceLoading(false);
    }
  }, [api, row.traceId]);

  return (
    <div className={styles.detailPanel} data-testid="activity-detail" role="region" aria-label="活动详情">
      <div className={styles.detailHead}>
        <h3>{row.eventName}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </div>
      <dl className={styles.detailGrid}>
        <div><dt>记录时间</dt><dd>{formatTime(row.recordedAt)}</dd></div>
        <div><dt>发生时间</dt><dd>{formatTime(row.occurredAt)}</dd></div>
        <div><dt>eventId</dt><dd><code className={styles.codeInline}>{row.eventId}</code></dd></div>
        <div><dt>级别 / 状态</dt><dd>{row.level} / {row.status ?? "—"}</dd></div>
        <div><dt>类别</dt><dd>{row.category}</dd></div>
        <div><dt>重要度</dt><dd>{row.significance ?? "—"}</dd></div>
        <div><dt>Actor</dt><dd>{row.actorKind}:{row.actorId}</dd></div>
        <div><dt>Executor</dt><dd>{row.executorKind}:{row.executorId}</dd></div>
        <div><dt>Target</dt><dd>{row.targetKind !== null ? `${row.targetKind}:${row.targetId ?? "—"}` : "—"}</dd></div>
        <div><dt>归属 Agent</dt><dd>{row.ownerAgentId ?? "—"}</dd></div>
        <div><dt>Session</dt><dd>{row.sessionId ?? "—"}</dd></div>
        <div><dt>时长</dt><dd>{row.durationMs !== null ? `${row.durationMs} ms` : "—"}</dd></div>
        <div><dt>errorCode</dt><dd>{row.errorCode ?? "—"}</dd></div>
        <div><dt>可重试</dt><dd>{row.retryable !== 0 ? "是" : "否"}</dd></div>
        <div><dt>traceId</dt><dd><code className={styles.codeInline}>{row.traceId}</code></dd></div>
        <div><dt>操作 ID</dt><dd>{row.operationId ?? "—"}</dd></div>
        <div><dt>生产者</dt><dd>{row.producerComponent} ({row.producerProcessType})</dd></div>
      </dl>
      <div className={styles.payloadBlock}>
        <div className={styles.payloadHead}>
          <strong>Payload（脱敏）</strong>
          {preview.truncated && (
            <Button variant="ghost" size="sm" onClick={() => setShowFullPayload(!showFullPayload)}>
              {showFullPayload ? "收起" : "展开全文"}
            </Button>
          )}
        </div>
        <pre className={styles.payloadPre}>
          {showFullPayload ? (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)) : preview.text}
        </pre>
      </div>
      {row.traceId !== "" && (
        <div className={styles.traceBlock}>
          <Button size="sm" variant="ghost" onClick={() => void loadTrace()} loading={traceLoading}>
            <GitBranch size={14} /> 查看 trace 树
          </Button>
          {traceError !== null && <p className={styles.inlineError} role="alert">{traceError}</p>}
          {trace !== null && <TracePanel response={trace} />}
        </div>
      )}
    </div>
  );
}

function TracePanel({ response }: { readonly response: TraceResponse }) {
  const { trace, linked } = response;
  if (trace.root === null && trace.total === 0 && linked === undefined) {
    return <p className={styles.muted}>该 trace 暂无节点。</p>;
  }
  return (
    <div className={styles.tracePanel} data-testid="trace-panel">
      <p className={styles.muted}>共 {trace.total} 个 span</p>
      {trace.root !== null ? (
        <ul className={styles.traceTree}>
          <TraceSpanNode span={trace.root} depth={0} />
        </ul>
      ) : (
        <p className={styles.muted}>根 span 不可用。</p>
      )}
      {linked !== undefined && (
        <div className={styles.linkedBlock}>
          <h4>关联 trace（linked graph）</h4>
          {linked.nodes.length === 0
            ? <p className={styles.muted}>无关联 trace。</p>
            : (
              <ul className={styles.linkedList}>
                {linked.nodes.map((node) => (
                  <li key={`${node.traceId}-${node.direction}-${node.relation}`}>
                    <code className={styles.codeInline}>{node.traceId}</code>
                    <span> {node.relation}（{node.direction === "forward" ? "正向" : "反向"}）</span>
                  </li>
                ))}
              </ul>
            )}
          {linked.truncated && (
            <p className={styles.warnNote}>
              关联图已截断（上限 depth {linked.maxDepth} / nodes {linked.maxNodes}）。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TraceSpanNode({ span, depth }: { readonly span: TraceSpan; readonly depth: number }) {
  return (
    <li className={styles.traceNode}>
      <div
        className={styles.traceRow}
        style={{ paddingLeft: `${depth * 18}px` }}
        data-testid={`trace-span-${span.spanId}`}
      >
        <span className={styles.traceBars} aria-hidden="true">{depth > 0 ? "├─" : ""}</span>
        <span className={styles.traceName}>{span.eventName}</span>
        {span.status !== null && <Badge variant={span.status === "failed" ? "danger" : span.status === "degraded" ? "warning" : "success"}>{span.status}</Badge>}
        <span className={styles.traceTime}>{formatTime(span.recordedAt)}</span>
        {span.durationMs !== null && <span className={styles.traceDuration}>{span.durationMs} ms</span>}
        {span.operationId !== null && <code className={styles.codeInline}>{span.operationId}</code>}
      </div>
      {span.children.length > 0 && (
        <ul className={styles.traceTree}>
          {span.children.map((child) => <TraceSpanNode key={child.id} span={child} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}
