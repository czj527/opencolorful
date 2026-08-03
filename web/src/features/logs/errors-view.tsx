import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { ActivityRow, ErrorGroup } from "../../lib/types.js";
import { Badge, Button, EmptyState, Spinner } from "../../components/ui/index.js";
import { formatTime } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface ErrorsViewProps {
  readonly api: ApiClient;
}

export function ErrorsView({ api }: ErrorsViewProps) {
  const [groups, setGroups] = useState<readonly ErrorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ErrorGroup | null>(null);
  const [samples, setSamples] = useState<readonly ActivityRow[]>([]);
  const [samplesLoading, setSamplesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.queryErrorGroups({ limit: 100 });
      setGroups(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "错误分组加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleGroup = useCallback(async (group: ErrorGroup) => {
    if (expanded?.eventName === group.eventName && expanded?.errorCode === group.errorCode) {
      setExpanded(null);
      setSamples([]);
      return;
    }
    setExpanded(group);
    setSamplesLoading(true);
    try {
      // 最近样例：不展示未脱敏 stack，仅取时间/状态/级别等展示字段
      const page = await api.queryActivity({
        eventName: group.eventName,
        ...(group.errorCode !== null ? { errorCode: group.errorCode } : {}),
      }, null, 5);
      setSamples(page.items);
    } catch (cause) {
      setSamples([]);
      setExpanded(null);
      setError(cause instanceof Error ? cause.message : "错误样例加载失败");
    } finally {
      setSamplesLoading(false);
    }
  }, [api, expanded]);

  const levelBadge = (level: string): ReactNode => (
    <Badge variant={level === "error" || level === "fatal" ? "danger" : "warning"}>{level}</Badge>
  );

  return (
    <section className={styles.tabPane} aria-label="错误分组">
      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <Button size="sm" onClick={() => void load()}><RefreshCw size={14} /> 重试</Button>
        </div>
      )}
      {loading ? (
        <div className={styles.loadingRow}><Spinner /> 正在加载错误分组…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          title="暂无错误记录"
          description="服务端记录的失败事件会在这里按事件名与错误码分组展示。"
        />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>错误码</th>
                  <th>次数</th>
                  <th>最近发生</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isOpen = expanded?.eventName === group.eventName && expanded?.errorCode === group.errorCode;
                  return (
                    <tr
                      key={`${group.eventName}-${group.errorCode ?? ""}`}
                      className={isOpen ? styles.rowActive : undefined}
                    >
                      <td><span className={styles.eventName}>{group.eventName}</span></td>
                      <td>{group.errorCode ?? "—"}</td>
                      <td>{group.count}</td>
                      <td>{formatTime(group.lastRecordedAt)}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.rowAction}
                          aria-label={`查看 ${group.eventName} 最近样例`}
                          onClick={() => void toggleGroup(group)}
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {expanded !== null && (
            <div className={styles.samplesBlock} data-testid="error-samples">
              <h4>最近样例（{expanded.eventName}{expanded.errorCode !== null ? ` / ${expanded.errorCode}` : ""}，最多 5 条）</h4>
              {samplesLoading ? (
                <div className={styles.loadingRow}><Spinner /> 加载样例中…</div>
              ) : samples.length === 0 ? (
                <p className={styles.muted}>该分组暂无更早的样例记录。</p>
              ) : (
                <ul className={styles.samplesList}>
                  {samples.map((sample) => (
                    <li key={sample.id}>
                      <span className={styles.colTime}>{formatTime(sample.recordedAt)}</span>
                      {levelBadge(sample.level)}
                      <Badge variant={sample.status === "failed" ? "danger" : "warning"}>{sample.status ?? "—"}</Badge>
                      <span className={styles.muted}>{sample.producerComponent}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
