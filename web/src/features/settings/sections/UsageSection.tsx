import { useEffect, useState } from "react";
import type { UsageSummaryResponse } from "../../../lib/types.js";
import { SettingsSubsection } from "../widgets/index.js";
import styles from "./UsageSection.module.css";

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
    return () => {
      cancelled = true;
    };
  }, [props, days]);

  const isEmpty = data !== null && data.totals.totalTokens === 0 && data.byDay.length === 0;

  return (
    <>
      <div className={styles.rangeSelector} role="group" aria-label="时间范围">
        {([7, 30, 90] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`${styles.rangeBtn} ${days === value ? styles.rangeBtnActive : ""}`}
            onClick={() => setDays(value)}
            aria-pressed={days === value}
          >
            {value} 天
          </button>
        ))}
      </div>

      {loading && <div className={styles.loading}>加载中…</div>}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!loading && error === null && isEmpty && (
        <div className={styles.empty}>
          <p>暂无用量数据</p>
          <p className={styles.emptyHint}>开始对话后，Token 消耗与缓存命中将在此展示。</p>
        </div>
      )}

      {!loading && error === null && data !== null && !isEmpty && (
        <>
          <div className={styles.overview}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>总 Tokens</div>
              <div className={styles.cardValue}>{formatNumber(data.totals.totalTokens)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>输入</div>
              <div className={styles.cardValue}>{formatNumber(data.totals.input)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>输出</div>
              <div className={styles.cardValue}>{formatNumber(data.totals.output)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>缓存读取</div>
              <div className={styles.cardValue}>{formatNumber(data.totals.cacheRead)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>缓存写入</div>
              <div className={styles.cardValue}>{formatNumber(data.totals.cacheWrite)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>加权平均缓存命中率</div>
              <div className={styles.cardValue}>{formatPercent(data.cacheHitRate)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>覆盖会话</div>
              <div className={styles.cardValue}>{formatNumber(data.sessions)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>覆盖轮次</div>
              <div className={styles.cardValue}>{formatNumber(data.turns)}</div>
            </div>
          </div>

          <SettingsSubsection title="按日用量">
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
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
          </SettingsSubsection>

          <SettingsSubsection title="按模型分布">
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
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
                    const share =
                      data.totals.totalTokens > 0
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
          </SettingsSubsection>
        </>
      )}
    </>
  );
}
