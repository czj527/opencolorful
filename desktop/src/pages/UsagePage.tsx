import { useEffect, useState } from "react";

import { formatErrorAdvice, toUserError } from "../errors.js";
import type { DesktopDataSource, UsageSummaryFilterView, UsageSummaryView, UsageTokenTotals } from "../data/source.js";

import "./usage-page.css";

const DAY_OPTIONS = [7, 30, 90] as const;

/** 来源/角色选项 value 与后端 query 参数一致；"" = 全部（不下发参数） */
const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "main", label: "主对话" },
  { value: "subagent", label: "子代理" },
  { value: "utility", label: "后台任务" },
] as const;

const ROLE_OPTIONS = [
  { value: "", label: "全部角色" },
  { value: "primary", label: "主模型" },
  { value: "secondary", label: "次级模型" },
] as const;

const SOURCE_LABELS: Record<UsageSummaryView["bySource"][number]["source"], string> = {
  main: "主对话",
  subagent: "子代理",
  utility: "后台任务",
};

const ROLE_LABELS: Record<UsageSummaryView["byRole"][number]["role"], string> = {
  primary: "主模型",
  secondary: "次级模型",
};

const STATUS_LABELS: Record<UsageSummaryView["byStatus"][number]["status"], string> = {
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
  interrupted: "已中断",
  budget_exhausted: "预算耗尽",
};

function statusClass(status: string): string {
  if (status === "failed" || status === "timeout") return "badge-err";
  if (["cancelled", "interrupted", "budget_exhausted"].includes(status)) return "badge-warn";
  return "badge-ok";
}

/** 大数字统一 toLocaleString（zh-CN 分组），缓存命中率 0-100 两位小数 */
function formatTokens(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(2)}%`;
}

function TotalsCell({ totals }: { readonly totals: UsageTokenTotals }) {
  return (
    <td className="col-dim">
      <span className="usage-token-detail">
        入 {formatTokens(totals.input)} · 出 {formatTokens(totals.output)} · 缓读 {formatTokens(totals.cacheRead)} · 缓写 {formatTokens(totals.cacheWrite)}
      </span>
    </td>
  );
}

interface UsagePageProps {
  readonly source: DesktopDataSource;
}

/** A8c：全局模型用量页（按时间范围/来源/角色过滤；只读汇总，无编辑入口） */
export function UsagePage({ source }: UsagePageProps) {
  const [days, setDays] = useState(30);
  const [sourceFilter, setSourceFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [summary, setSummary] = useState<UsageSummaryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const filter: UsageSummaryFilterView = {
      days,
      ...(sourceFilter !== "" ? { source: sourceFilter } : {}),
      ...(roleFilter !== "" ? { role: roleFilter } : {}),
    };
    source.getUsageSummary(filter)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(formatErrorAdvice(toUserError(cause, "loadUsage")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source, days, sourceFilter, roleFilter, retryCount]);

  const hasRecords = summary !== null && summary.calls > 0;

  return (
    <div className="page-column page-wide" data-testid="oc-usage-page">
      <header className="page-head">
        <div className="page-head-row">
          <h1>用量</h1>
        </div>
        <p>全局模型 token 用量汇总（输入 / 输出 / 缓存读写），支持按时间范围、来源与角色过滤。</p>
      </header>

      <div className="log-filters">
        <select
          data-testid="oc-usage-days-filter"
          aria-label="时间范围"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {DAY_OPTIONS.map((option) => <option key={option} value={option}>近 {option} 天</option>)}
        </select>
        <select
          data-testid="oc-usage-source-filter"
          aria-label="来源过滤"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          {SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          data-testid="oc-usage-role-filter"
          aria-label="角色过滤"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
        >
          {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {error !== null && (
        <div className="chat-error" role="alert" data-testid="oc-usage-error">
          {error}
          <button
            type="button"
            className="inline-action"
            data-testid="oc-usage-retry"
            onClick={() => setRetryCount((n) => n + 1)}
          >重试</button>
        </div>
      )}

      {loading && <p className="page-empty" data-testid="oc-usage-loading">正在加载用量数据…</p>}

      {!loading && error === null && summary !== null && !hasRecords && (
        <div className="empty-state" data-testid="oc-usage-empty">
          <h1>暂无模型用量记录</h1>
          <p className="page-empty">与模型对话或运行子代理后，这里会展示 token 用量汇总。可尝试放宽过滤条件或扩大时间范围。</p>
        </div>
      )}

      {!loading && error === null && hasRecords && summary !== null && (
        <>
          <section className="usage-section" aria-label="用量汇总">
            <div className="usage-total-card" data-testid="oc-usage-total-card">
              <strong>总 token</strong>
              <span className="usage-total-value">{formatTokens(summary.totals.totalTokens)}</span>
              <small>缓存命中率 {formatPercent(summary.cacheHitRate)} · 近 {summary.days} 天</small>
            </div>
            <div className="stat-grid usage-stat-grid">
              <div className="stat-card" data-testid="oc-usage-stat-input">
                <strong>输入</strong>
                <span className="stat-value">{formatTokens(summary.totals.input)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-output">
                <strong>输出</strong>
                <span className="stat-value">{formatTokens(summary.totals.output)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-cache-read">
                <strong>缓存读</strong>
                <span className="stat-value">{formatTokens(summary.totals.cacheRead)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-cache-write">
                <strong>缓存写</strong>
                <span className="stat-value">{formatTokens(summary.totals.cacheWrite)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-calls">
                <strong>调用次数</strong>
                <span className="stat-value">{formatTokens(summary.calls)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-turns">
                <strong>主对话轮次</strong>
                <span className="stat-value">{formatTokens(summary.turns)}</span>
              </div>
              <div className="stat-card" data-testid="oc-usage-stat-sessions">
                <strong>会话数</strong>
                <span className="stat-value">{formatTokens(summary.sessions)}</span>
              </div>
            </div>
          </section>

          <section className="usage-section" aria-label="按来源">
            <h2>按来源</h2>
            <table className="table">
              <thead>
                <tr><th>来源</th><th>调用</th><th>Token 明细</th><th>合计</th></tr>
              </thead>
              <tbody>
                {summary.bySource.map((row) => (
                  <tr key={row.source} data-testid={`oc-usage-source-row-${row.source}`}>
                    <td className="col-event">{SOURCE_LABELS[row.source]}</td>
                    <td>{formatTokens(row.calls)}</td>
                    <TotalsCell totals={row} />
                    <td className="usage-total-cell">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="usage-section" aria-label="按状态">
            <h2>按状态</h2>
            <table className="table">
              <thead>
                <tr><th>状态</th><th>调用</th><th>Token 明细</th><th>合计</th></tr>
              </thead>
              <tbody>
                {summary.byStatus.map((row) => (
                  <tr key={row.status} data-testid={`oc-usage-status-row-${row.status}`}>
                    <td><span className={`badge ${statusClass(row.status)}`}>{STATUS_LABELS[row.status]}</span></td>
                    <td>{formatTokens(row.calls)}</td>
                    <TotalsCell totals={row} />
                    <td className="usage-total-cell">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="usage-section" aria-label="按模型">
            <h2>按模型</h2>
            <table className="table">
              <thead>
                <tr><th>模型</th><th>Token 明细</th><th>合计</th></tr>
              </thead>
              <tbody>
                {summary.byModel.slice(0, 5).map((row) => (
                  <tr key={`${row.provider}/${row.model}`} data-testid={`oc-usage-model-row-${row.provider}-${row.model}`}>
                    <td className="col-event"><code>{row.provider}/{row.model}</code></td>
                    <TotalsCell totals={row} />
                    <td className="usage-total-cell">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="usage-section" aria-label="按日期">
            <h2>按日期</h2>
            <table className="table">
              <thead>
                <tr><th>日期</th><th>Token 明细</th><th>合计</th></tr>
              </thead>
              <tbody>
                {summary.byDay.map((row) => (
                  <tr key={row.date} data-testid={`oc-usage-day-row-${row.date}`}>
                    <td className="col-time">{row.date}</td>
                    <TotalsCell totals={row} />
                    <td className="usage-total-cell">{formatTokens(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
