import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { DailyMetric } from "../../lib/types.js";
import { Button, EmptyState, Spinner } from "../../components/ui/index.js";
import styles from "./LogsPage.module.css";

export interface PerformanceViewProps {
  readonly api: ApiClient;
}

const DAYS = 7;

export function PerformanceView({ api }: PerformanceViewProps) {
  const [items, setItems] = useState<readonly DailyMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.queryDailyMetrics(DAYS);
      setItems(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "性能指标加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxCount = items.reduce((max, item) => Math.max(max, item.eventCount), 1);

  return (
    <section className={styles.tabPane} aria-label="性能指标">
      <p className={styles.muted}>按日聚合的事件量（最近 {DAYS} 天，live 计算）。</p>
      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <Button size="sm" onClick={() => void load()}><RefreshCw size={14} /> 重试</Button>
        </div>
      )}
      {loading ? (
        <div className={styles.loadingRow}><Spinner /> 正在加载性能指标…</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无指标数据"
          description="运行一段时间后这里会展示每日事件量、错误量与失败量。"
        />
      ) : (
        <ul className={styles.metricList} data-testid="metric-list">
          {items.map((item) => (
            <li key={item.date} className={styles.metricRow}>
              <div className={styles.metricHead}>
                <strong>{item.date}</strong>
                <span className={styles.muted}>
                  error {item.errorCount} · failed {item.failedCount} · degraded {item.degradedCount}
                </span>
              </div>
              <div className={styles.metricBars}>
                <div className={styles.barRow}>
                  <span className={styles.barLabel}>事件</span>
                  <div className={styles.bar} role="img" aria-label={`事件量 ${item.eventCount}`}>
                    <div
                      className={styles.barEvent}
                      style={{ width: `${Math.max(2, Math.round((item.eventCount / maxCount) * 100))}%` }}
                    />
                  </div>
                  <b>{item.eventCount}</b>
                </div>
                {Object.entries(item.byLevel).map(([level, count]) => (
                  <div className={styles.barRow} key={level}>
                    <span className={styles.barLabel}>{level}</span>
                    <div className={styles.bar} role="img" aria-label={`${level} ${count}`}>
                      <div
                        className={styles.barLevel}
                        style={{ width: `${Math.max(2, Math.round((count / maxCount) * 100))}%` }}
                      />
                    </div>
                    <b>{count}</b>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
