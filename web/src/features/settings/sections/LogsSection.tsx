import { useCallback, useEffect, useRef, useState } from "react";
import type { LogTail } from "../../../lib/types.js";
import { Button } from "../../../components/ui/index.js";
import { Select, TextField } from "../../../components/ui/index.js";
import { navigateToLogs } from "../../../app/page-router.js";
import styles from "./LogsSection.module.css";

export interface LogsSectionProps {
  readonly getSupervisorLogs: (query?: {
    limit?: number;
    level?: "all" | "info" | "warn" | "error";
    query?: string;
    since?: string | null;
  }) => Promise<LogTail>;
}

export function LogsSection(props: LogsSectionProps) {
  const [logs, setLogs] = useState("");
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLogs = useCallback(
    async (resetCursor: boolean) => {
      try {
        const q: {
          limit: number;
          level?: "info" | "warn" | "error";
          query?: string;
          since?: string | null;
        } = { limit: 200 };
        if (level !== "all") q.level = level;
        if (search.length > 0) q.query = search;
        if (!resetCursor && cursor !== null) q.since = cursor;

        const tail = await props.getSupervisorLogs(q);
        if (resetCursor) {
          setLogs(tail.logs);
        } else if (tail.logs.length > 0) {
          setLogs((prev) => prev + tail.logs);
        }
        if (tail.nextCursor !== null) setCursor(tail.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "日志加载失败");
      }
    },
    [props, level, search, cursor],
  );

  useEffect(() => {
    setLogs("");
    setCursor(null);
    void fetchLogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, search]);

  const handleRefresh = useCallback(() => {
    setLogs("");
    setCursor(null);
    void fetchLogs(true);
  }, [fetchLogs]);

  useEffect(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => void fetchLogs(false), 2_000);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [fetchLogs]);

  return (
    <>
      <div className={styles.entryRow}>
        <span data-testid="open-logs-page">
          <Button size="sm" onClick={navigateToLogs}>
            打开完整日志工作页 →
          </Button>
        </span>
        <span className={styles.entryHint}>查看活动时间线、错误分组、安全审计、性能指标与诊断导出。</span>
      </div>

      <div className={styles.toolbar}>
        <Select
          value={level}
          onChange={(v) => setLevel(v as "all" | "info" | "warn" | "error")}
          aria-label="日志级别"
          className={styles.levelSelect ?? ""}
        >
          <option value="all">全部</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
        <TextField
          value={search}
          onChange={setSearch}
          placeholder="关键词过滤"
          aria-label="日志关键词过滤"
          className={styles.searchInput ?? ""}
        />
        <Button variant="ghost" size="sm" onClick={handleRefresh}>
          刷新
        </Button>
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <pre className={styles.viewer}>{logs || "暂无日志"}</pre>
    </>
  );
}
