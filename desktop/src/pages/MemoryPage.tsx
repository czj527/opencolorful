import { RefreshCw, Search, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { DesktopDataSource, MemoryPageData } from "../data/source.js";
import { maintenanceLabel, type Agent, type MemoryMaintenance } from "../mock-data.js";

const compiledSections = [
  ["today", "今天"],
  ["week", "本周"],
  ["longterm", "长期"],
  ["facts", "重要事实"],
] as const;

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function StrengthBar({ label, value, className }: { readonly label: string; readonly value: number; readonly className: string }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar"><div className={className} style={{ width: `${Math.min(100, value)}%` }} /></div>
      <b>{value}</b>
    </div>
  );
}

interface MemoryPageProps {
  readonly source: DesktopDataSource;
  readonly agent: Agent;
}

export function MemoryPage({ source, agent }: MemoryPageProps) {
  const [data, setData] = useState<MemoryPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const keyword = debouncedQuery.trim();
    const request = keyword === ""
      ? source.getMemoryData(agent.id)
      : source.getMemoryData(agent.id, keyword);
    request
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setMaintenance(next.maintenance);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "记忆加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, agent.id, debouncedQuery]);

  useEffect(() => {
    if (source.info.mode !== "ipc") return;
    return source.subscribeMemoryMaintenance(agent.id, (next) => setMaintenance(next));
  }, [source, agent.id]);

  const facts = data?.facts ?? [];
  const events = data?.events ?? [];

  const latestEpisode = data?.health.latestRecallEpisodes[0];
  const maintenanceText = maintenance !== null ? maintenanceLabel(maintenance.status, maintenance.phase) : "空闲";

  const canShowReport = maintenance !== null
    && maintenance.runId !== undefined
    && (maintenance.status === "completed" || maintenance.status === "deferred" || maintenance.status === "failed");

  const runDeepDive = () => {
    setError(null);
    source.deepDiveMemory(agent.id)
      .then(() => setMaintenance({ status: "queued", at: new Date().toISOString() }))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "整理触发失败"));
  };

  const openReport = () => {
    if (maintenance === null || maintenance.runId === undefined) return;
    setError(null);
    source.getMemoryRunReport(agent.id, maintenance.runId)
      .then(setReport)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "报告加载失败"));
  };

  return (
    <div className="page-column">
      <header className="page-head">
        <h1>记忆</h1>
        <p>{agent.name} 的只读记忆视图：四段上下文制品、已审批事实、回想健康与后台整理状态。</p>
        <div className="log-filters">
          <label className="filter-box">
            <Search size={13} />
            <input type="search" placeholder="搜索事实与事件…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
      </header>

      {error !== null && (
        <div className="chat-error" role="alert">
          {error}
          <button type="button" className="inline-action" onClick={() => {
            setLoading(true);
            setError(null);
            source.getMemoryData(agent.id).then(setData).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "记忆加载失败")).finally(() => setLoading(false));
          }}>重试</button>
        </div>
      )}
      {loading && <p className="page-empty">正在加载记忆…</p>}

      {!loading && data !== null && (
        <>
          <section className="stat-grid" aria-label="记忆健康状态">
            <div className="stat-card">
              <strong>RecallEpisode</strong>
              <span className="stat-value">{data.health.latestRecallStatus}</span>
              <small>{latestEpisode ? `${latestEpisode.resultCount} 个结果 · ${latestEpisode.layer}` : "等待回想"}</small>
            </div>
            <div className="stat-card">
              <strong>Pending batch</strong>
              <span className="stat-value">{data.health.pendingBatches.length}</span>
              <small>封存队列状态</small>
            </div>
            <div className="stat-card">
              <strong>后台整理</strong>
              <span className={`stat-value${maintenance?.status === "failed" ? " s-failed" : ""}`}>{maintenanceText}</span>
              <small>
                {maintenance?.runId ? `run ${maintenance.runId.slice(0, 12)}… · ${formatTime(maintenance.at)}` : "空闲窗口每日运行"}
              </small>
            </div>
            <div className="stat-card stat-actions">
              <button type="button" className="btn" onClick={runDeepDive}><WandSparkles size={13} />立即整理</button>
              {canShowReport && <button type="button" className="btn" onClick={openReport}>查看报告</button>}
              <button type="button" className="icon-btn" aria-label="刷新" title="刷新" onClick={() => {
                setError(null);
                void source.getMemoryData(agent.id).then(setData).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "刷新失败"));
              }}><RefreshCw size={14} /></button>
            </div>
          </section>

          {report !== null && (
            <details className="compiled-block">
              <summary>最近运行报告（脱敏）</summary>
              <pre>{report}</pre>
            </details>
          )}

          <section className="page-section">
            <h2>编译记忆<small>四段上下文制品</small></h2>
            <div className="compiled-grid">
              {compiledSections.map(([key, label]) => (
                <details className="compiled-block" key={key} open={key === "today"}>
                  <summary>{label}</summary>
                  {data.compiled[key] ? <pre>{data.compiled[key]}</pre> : <p className="page-empty">暂无内容</p>}
                </details>
              ))}
            </div>
          </section>

          <div className="two-col">
            <section className="page-section">
              <h2>置顶记忆<small>{data.pinned.length}</small></h2>
              <div className="plain-list">
                {data.pinned.map((item) => (
                  <div className="plain-list-item" key={item.id}>
                    <div className="static-row"><span>{item.content}</span><small>{formatTime(item.createdAt)}</small></div>
                  </div>
                ))}
                {data.pinned.length === 0 && <p className="page-empty">暂无置顶记忆</p>}
              </div>
            </section>
            <section className="page-section">
              <h2>已审批事实<small>{facts.length}</small></h2>
              <div className="plain-list">
                {facts.map((fact) => (
                  <div className="plain-list-item" key={fact.id}>
                    <div className="static-row">
                      <span>{fact.fact}</span>
                      <small>{fact.tags.join(" · ")} · confidence {fact.confidence}</small>
                    </div>
                  </div>
                ))}
                {facts.length === 0 && <p className="page-empty">暂无匹配事实</p>}
              </div>
            </section>
          </div>

          <section className="page-section">
            <h2>强度时间线<small>派生视图，不落库</small></h2>
            <div className="strength-list">
              {data.timelineFacts.map((fact) => (
                <div className="strength-item" key={fact.id}>
                  <div className="strength-head">
                    <strong>{fact.fact}</strong>
                    <small>
                      {fact.status} · confidence {fact.confidence} · {fact.hitDates} 个回想日
                      {fact.validUntil ? ` · 有效至 ${formatTime(fact.validUntil)}` : ""}
                    </small>
                  </div>
                  <StrengthBar label="retention" value={fact.retentionStrength} className="bar-retention" />
                  <StrengthBar label="activation" value={fact.activationStrength} className="bar-activation" />
                </div>
              ))}
              {data.timelineEvents.map((event) => (
                <div className="strength-item" key={event.id}>
                  <div className="strength-head">
                    <strong>{event.summary}</strong>
                    <small>事件 · {event.status} · {formatTime(event.date)}</small>
                  </div>
                  <StrengthBar label="salience" value={event.salience} className="bar-salience" />
                </div>
              ))}
              {data.timelineFacts.length === 0 && data.timelineEvents.length === 0 && <p className="page-empty">暂无强度数据</p>}
            </div>
          </section>

          <section className="page-section">
            <h2>事件时间线<small>{events.length}</small></h2>
            <div className="plain-list">
              {events.map((event) => (
                <div className="plain-list-item" key={event.id}>
                  <div className="static-row">
                    <span>{event.summary}</span>
                    <small>
                      {formatTime(event.date)} · {event.topics.join(" · ")}
                      {event.sessionId ? ` · Session ${event.sessionId}` : ""}
                      {typeof event.messageCount === "number" ? ` · ${event.messageCount} 条消息` : ""}
                    </small>
                  </div>
                </div>
              ))}
              {events.length === 0 && <p className="page-empty">暂无匹配事件</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
