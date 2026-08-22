import { RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import type { ActivityFilter, DesktopDataSource, LogsPageData } from "../data/source.js";
import {
  activityCategories,
  activityLevels,
  activityStatuses,
  type ActivityLogRow,
  type AuditLogRow,
} from "../mock-data.js";

import "./pages.css";

type LogTab = "activity" | "errors" | "audit";

const tabs: readonly { id: LogTab; label: string }[] = [
  { id: "activity", label: "活动" },
  { id: "errors", label: "错误" },
  { id: "audit", label: "安全审计" },
];

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "badge-err";
  if (level === "warn") return "badge-warn";
  return "badge-muted";
}

function statusClass(status: string): string {
  if (status === "failed" || status === "denied") return "badge-err";
  if (["degraded", "cancelled", "interrupted", "deferred", "retrying"].includes(status)) return "badge-warn";
  return "badge-ok";
}

function decisionClass(decision: string): string {
  if (decision === "allowed") return "badge-ok";
  if (decision === "denied") return "badge-err";
  return "badge-warn";
}

function HealthBadges({ health }: { readonly health: LogsPageData["health"] }) {
  if (health === null) {
    return <div className="badge-row"><span className="badge badge-err">健康不可用</span></div>;
  }
  const badges: { key: string; label: string; cls: string }[] = [];
  if (health.logger.degraded) badges.push({ key: "degraded", label: "logger 降级", cls: "badge-warn" });
  if (health.logger.dropped > 0) badges.push({ key: "dropped", label: `事件丢弃 ${health.logger.dropped}`, cls: "badge-err" });
  if (health.logger.failed > 0) badges.push({ key: "failed", label: `写入失败 ${health.logger.failed}`, cls: "badge-warn" });
  if (health.spool.pendingSegments > 0) badges.push({ key: "spool", label: `spool 待处理 ${health.spool.pendingSegments}`, cls: "badge-warn" });
  badges.push({ key: "epoch", label: `Epoch ${health.auditEpoch}`, cls: "badge-muted" });
  badges.push({ key: "disk", label: `磁盘 ${health.logger.diskTotalMb} MB`, cls: "badge-muted" });
  return (
    <div className="badge-row">
      {badges.map((badge) => <span key={badge.key} className={`badge ${badge.cls}`}>{badge.label}</span>)}
    </div>
  );
}

function matchesFilter(row: ActivityLogRow, filter: {
  readonly category: string;
  readonly level: string;
  readonly status: string;
  readonly search: string;
}): boolean {
  if (filter.category !== "" && row.category !== filter.category) return false;
  if (filter.level !== "" && row.level !== filter.level) return false;
  if (filter.status !== "" && row.status !== filter.status) return false;
  const kw = filter.search.trim();
  if (kw !== "" && !row.eventName.includes(kw) && !row.producerComponent.includes(kw)) return false;
  return true;
}

function dedupeById(rows: readonly ActivityLogRow[]): ActivityLogRow[] {
  const seen = new Set<number>();
  const out: ActivityLogRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function ActivityView({ source, refreshKey }: {
  readonly source: DesktopDataSource;
  readonly refreshKey: number;
}) {
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<readonly ActivityLogRow[]>([]);
  const [liveRows, setLiveRows] = useState<readonly ActivityLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [liveFollow, setLiveFollow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const filter: ActivityFilter = {
      ...(category !== "" ? { category } : {}),
      ...(level !== "" ? { level } : {}),
      ...(status !== "" ? { status } : {}),
      ...(debouncedSearch.trim() !== "" ? { search: debouncedSearch.trim() } : {}),
    };
    source.queryActivity(filter)
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows);
        setLiveRows([]);
        setNextCursor(result.nextCursor);
        setOpenId(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "活动加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source, category, level, status, debouncedSearch, refreshKey]);

  useEffect(() => {
    if (!liveFollow) return undefined;
    return source.subscribeActivityStream((row) => {
      if (!matchesFilter(row, { category, level, status, search })) return;
      setRows((prev) => dedupeById([row, ...prev]));
      setLiveRows((prev) => dedupeById([row, ...prev]));
    });
  }, [source, liveFollow, category, level, status, search]);

  const displayRows = useMemo(() => dedupeById([...liveRows, ...rows]), [liveRows, rows]);

  const loadMore = () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const filter: ActivityFilter = {
      ...(category !== "" ? { category } : {}),
      ...(level !== "" ? { level } : {}),
      ...(status !== "" ? { status } : {}),
      ...(debouncedSearch.trim() !== "" ? { search: debouncedSearch.trim() } : {}),
    };
    source.queryActivity(filter, nextCursor)
      .then((result) => {
        setRows((prev) => dedupeById([...prev, ...result.rows]));
        setNextCursor(result.nextCursor);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载更多失败"))
      .finally(() => setLoadingMore(false));
  };

  return (
    <section aria-label="活动事件">
      <div className="log-filters">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="类别过滤">
          <option value="">全部类别</option>
          {activityCategories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="级别过滤">
          <option value="">全部级别</option>
          {activityLevels.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状态过滤">
          <option value="">全部状态</option>
          {activityStatuses.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label className="filter-box">
          <input type="search" placeholder="事件名 / 组件" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="live-follow">
          <span>实时跟随</span>
          <button
            type="button"
            role="switch"
            aria-checked={liveFollow}
            aria-label="实时跟随开关"
            className={`toggle${liveFollow ? " is-on" : ""}`}
            onClick={() => setLiveFollow((v) => !v)}
          ><i /></button>
          {liveRows.length > 0 && <span className="badge badge-ok">+{liveRows.length}</span>}
        </label>
      </div>
      {error !== null && <div className="chat-error" role="alert">{error}</div>}
      {loading ? (
        <p className="page-empty">正在加载活动事件…</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>时间</th><th>事件</th><th>级别</th><th>状态</th><th>类别</th><th>组件</th><th>时长</th></tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <ActivityRow key={row.id} row={row} open={openId === row.id} onToggle={() => setOpenId(openId === row.id ? null : row.id)} />
            ))}
          </tbody>
        </table>
      )}
      {!loading && displayRows.length === 0 && <p className="page-empty">暂无匹配的活动事件。</p>}
      {nextCursor !== null && (
        <div className="load-more">
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </section>
  );
}

function ActivityRow({ row, open, onToggle }: { readonly row: ActivityLogRow; readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <>
      <tr className={open ? "is-open" : ""} onClick={onToggle}>
        <td className="col-time">{formatTime(row.recordedAt)}</td>
        <td className="col-event">{row.eventName}</td>
        <td><span className={`badge ${levelClass(row.level)}`}>{row.level}</span></td>
        <td><span className={`badge ${statusClass(row.status)}`}>{row.status}</span></td>
        <td className="col-dim">{row.category}</td>
        <td className="col-dim"><code>{row.producerComponent}</code></td>
        <td className="col-dim">{row.durationMs !== null ? `${row.durationMs} ms` : "—"}</td>
      </tr>
      {open && (
        <tr className="row-detail">
          <td colSpan={7}>
            <dl className="detail-grid">
              <div><dt>Session</dt><dd>{row.sessionId ?? "—"}</dd></div>
              <div><dt>归属 Agent</dt><dd>{row.ownerAgentId ?? "—"}</dd></div>
              <div><dt>traceId</dt><dd><code>{row.traceId || "—"}</code></dd></div>
              <div><dt>Payload（脱敏）</dt><dd><code>{row.payloadPreview || "—"}</code></dd></div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function ErrorsView({ data }: { readonly data: LogsPageData }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <section aria-label="错误分组">
      <table className="table">
        <thead>
          <tr><th>事件</th><th>错误码</th><th>次数</th><th>最近发生</th></tr>
        </thead>
        <tbody>
          {data.errors.map((group) => {
            const key = `${group.eventName}/${group.errorCode ?? ""}`;
            const open = openKey === key;
            const samples = open ? data.activity.filter((row) => row.eventName === group.eventName).slice(0, 5) : [];
            return (
              <Fragment key={key}>
                <tr className={open ? "is-open" : ""} onClick={() => setOpenKey(open ? null : key)}>
                  <td className="col-event">{group.eventName}</td>
                  <td className="col-dim">{group.errorCode ?? "—"}</td>
                  <td>{group.count}</td>
                  <td className="col-time">{formatTime(group.lastRecordedAt)}</td>
                </tr>
                {open && (
                  <tr className="row-detail">
                    <td colSpan={4}>
                      {samples.length === 0 ? <span className="page-empty">该分组暂无样例记录。</span> : (
                        <ul className="sample-list">
                          {samples.map((sample) => (
                            <li key={sample.id}>
                              <span className="col-time">{formatTime(sample.recordedAt)}</span>
                              <span className={`badge ${levelClass(sample.level)}`}>{sample.level}</span>
                              <span className={`badge ${statusClass(sample.status)}`}>{sample.status}</span>
                              <code>{sample.producerComponent}</code>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {data.errors.length === 0 && <p className="page-empty">暂无错误记录。</p>}
    </section>
  );
}

function AuditView({ rows, auditEpoch }: { readonly rows: readonly AuditLogRow[]; readonly auditEpoch: number }) {
  const [epoch, setEpoch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const epochOptions: number[] = [];
  for (let value = auditEpoch; value >= Math.max(1, auditEpoch - 2); value -= 1) epochOptions.push(value);
  const visible = rows.filter((row) => epoch === "" || row.ledgerEpoch === Number(epoch));

  return (
    <section aria-label="安全审计">
      <div className="log-filters">
        <select value={epoch} onChange={(e) => setEpoch(e.target.value)} aria-label="Epoch 过滤">
          <option value="">全部 Epoch</option>
          {epochOptions.map((value) => <option key={value} value={String(value)}>Epoch {value}</option>)}
        </select>
        <span className="page-empty">审计账本只读，无编辑或删除入口。</span>
      </div>
      <table className="table">
        <thead>
          <tr><th>时间</th><th>事件</th><th>Decision</th><th>Actor</th><th>Epoch</th></tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <AuditRow key={row.id} row={row} open={openId === row.id} onToggle={() => setOpenId(openId === row.id ? null : row.id)} />
          ))}
        </tbody>
      </table>
      {visible.length === 0 && <p className="page-empty">暂无审计记录。</p>}
    </section>
  );
}

function AuditRow({ row, open, onToggle }: { readonly row: AuditLogRow; readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <>
      <tr className={open ? "is-open" : ""} onClick={onToggle}>
        <td className="col-time">{formatTime(row.recordedAt)}</td>
        <td className="col-event">{row.eventName}<div className="col-dim">{row.action}</div></td>
        <td><span className={`badge ${decisionClass(row.decision)}`}>{row.decision}</span></td>
        <td className="col-dim">{row.actorKind}:{row.actorId}</td>
        <td className="col-dim">{row.ledgerEpoch}</td>
      </tr>
      {open && (
        <tr className="row-detail">
          <td colSpan={5}>
            <dl className="detail-grid">
              <div><dt>reasonCode</dt><dd>{row.reasonCode ?? "—"}</dd></div>
              <div><dt>Session</dt><dd>{row.sessionId ?? "—"}</dd></div>
              <div><dt>traceId</dt><dd><code>{row.traceId}</code></dd></div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

interface LogsPageProps {
  readonly source: DesktopDataSource;
}

export function LogsPage({ source }: LogsPageProps) {
  const [tab, setTab] = useState<LogTab>("activity");
  const [data, setData] = useState<LogsPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityRefresh, setActivityRefresh] = useState(0);

  const load = () => {
    setError(null);
    source.getLogsData()
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "日志加载失败"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const refresh = () => {
    if (tab === "activity") {
      setActivityRefresh((n) => n + 1);
    } else {
      load();
    }
  };

  return (
    <div className="page-column page-wide">
      <header className="page-head">
        <div className="page-head-row">
          <h1>日志</h1>
          <button type="button" className="icon-btn" aria-label="刷新日志" title="刷新日志" onClick={refresh}>
            <RefreshCw size={14} />
          </button>
        </div>
        <p>Diagnostic / Activity / Audit 三通道；所有敏感值已脱敏，账本只读。</p>
        {data !== null && <HealthBadges health={data.health} />}
      </header>
      {error !== null && <div className="chat-error" role="alert">{error}</div>}
      {loading && <p className="page-empty">正在加载日志…</p>}
      {!loading && data !== null && (
        <>
          <nav className="sub-tabs" aria-label="日志视图">
            {tabs.map((item) => (
              <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
          {tab === "activity" && <ActivityView source={source} refreshKey={activityRefresh} />}
          {tab === "errors" && <ErrorsView data={data} />}
          {tab === "audit" && <AuditView rows={data.audit} auditEpoch={data.health?.auditEpoch ?? 0} />}
        </>
      )}
    </div>
  );
}
