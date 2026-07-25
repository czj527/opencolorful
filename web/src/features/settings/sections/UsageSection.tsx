import { useEffect, useState } from "react";
import type { UsageSummaryResponse } from "../../../lib/types.js";

export interface UsageSectionProps {
  readonly getUsageSummary: (days: number) => Promise<UsageSummaryResponse>;
}

type RangeDays = 7 | 30 | 90;

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function dayHitRate(input: number, cacheRead: number): number | null {
  const denominator = input + cacheRead;
  return denominator > 0 ? cacheRead / denominator : null;
}

export function UsageSection(props: UsageSectionProps) {
  const [days, setDays] = useState<RangeDays>(30);
  const [data, setData] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await props.getUsageSummary(days);
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "用量数据加载失败");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [props, days]);

  const isEmpty = data !== null && data.totals.totalTokens === 0 && data.byDay.length === 0;

  return (
    <section className="settings-section" data-testid="settings-section-usage">
      <h2>用量统计</h2>
      <p className="settings-desc">查看 Token 消耗与缓存命中情况，支持按时间范围筛选。</p>

      <div className="usage-range-selector" role="group" aria-label="时间范围">
        {([7, 30, 90] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`usage-range-btn ${days === value ? "active" : ""}`}
            onClick={() => setDays(value)}
            aria-pressed={days === value}
          >
            {value} 天
          </button>
        ))}
      </div>

      {loading && <div className="settings-loading">加载中…</div>}
      {error !== null && <div className="save-error" role="alert">{error}</div>}

      {!loading && error === null && isEmpty && (
        <div className="usage-empty">
          <p>暂无用量数据</p>
          <p className="usage-empty-hint">开始对话后，Token 消耗与缓存命中将在此展示。</p>
        </div>
      )}

      {!loading && error === null && data !== null && !isEmpty && (
        <>
          <div className="usage-overview">
            <div className="usage-card">
              <div className="usage-card-label">总 Tokens</div>
              <div className="usage-card-value">{formatNumber(data.totals.totalTokens)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">输入</div>
              <div className="usage-card-value">{formatNumber(data.totals.input)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">输出</div>
              <div className="usage-card-value">{formatNumber(data.totals.output)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">缓存读取</div>
              <div className="usage-card-value">{formatNumber(data.totals.cacheRead)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">缓存写入</div>
              <div className="usage-card-value">{formatNumber(data.totals.cacheWrite)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">加权平均缓存命中率</div>
              <div className="usage-card-value">{formatPercent(data.cacheHitRate)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">覆盖会话</div>
              <div className="usage-card-value">{formatNumber(data.sessions)}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">覆盖轮次</div>
              <div className="usage-card-value">{formatNumber(data.turns)}</div>
            </div>
          </div>

          <h3 className="settings-subsection-title">按日用量</h3>
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读取</th>
                  <th>缓存写入</th>
                  <th>总 Tokens</th>
                  <th>命中率</th>
                </tr>
              </thead>
              <tbody>
                {data.byDay.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{formatNumber(row.input)}</td>
                    <td>{formatNumber(row.output)}</td>
                    <td>{formatNumber(row.cacheRead)}</td>
                    <td>{formatNumber(row.cacheWrite)}</td>
                    <td>{formatNumber(row.totalTokens)}</td>
                    <td>{formatPercent(dayHitRate(row.input, row.cacheRead))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="settings-subsection-title">按模型分布</h3>
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Provider / 模型</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读取</th>
                  <th>缓存写入</th>
                  <th>总 Tokens</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((row) => {
                  const share = data.totals.totalTokens > 0
                    ? (row.totalTokens / data.totals.totalTokens) * 100
                    : 0;
                  return (
                    <tr key={`${row.provider}/${row.model}`}>
                      <td>{row.provider} / {row.model}</td>
                      <td>{formatNumber(row.input)}</td>
                      <td>{formatNumber(row.output)}</td>
                      <td>{formatNumber(row.cacheRead)}</td>
                      <td>{formatNumber(row.cacheWrite)}</td>
                      <td>{formatNumber(row.totalTokens)}</td>
                      <td>{share.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
