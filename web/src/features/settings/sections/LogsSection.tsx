import { useCallback, useEffect, useRef, useState } from "react";
import type { LogTail } from "../../../lib/types.js";

export interface LogsSectionProps {
  readonly getSupervisorLogs: (query?: { limit?: number; level?: "all" | "info" | "warn" | "error"; query?: string; since?: string | null }) => Promise<LogTail>;
}

export function LogsSection(props: LogsSectionProps) {
  const [logs, setLogs] = useState("");
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLogs = useCallback(async (resetCursor: boolean) => {
    try {
      const q: { limit: number; level?: "info" | "warn" | "error"; query?: string; since?: string | null } = { limit: 200 };
      if (level !== "all") q.level = level;
      if (search.length > 0) q.query = search;
      // 增量读取：使用上次返回的 cursor，仅拉取新增行
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
  }, [props, level, search, cursor]);

  // level/search 变更时重置 cursor 并按需全量刷新
  const refreshFull = useCallback(() => {
    setCursor(null);
  }, []);

  useEffect(() => {
    void fetchLogs(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, search]);

  useEffect(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => void fetchLogs(false), 2_000);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [fetchLogs]);

  return (
    <section className="settings-section" data-testid="settings-section-logs">
      <h2>日志与诊断</h2>
      <p className="settings-desc">Supervisor 和 Agent Server 运行日志。</p>

      <div className="logs-toolbar">
        <select value={level} onChange={(e) => setLevel(e.target.value as "all" | "info" | "warn" | "error")}>
          <option value="all">全部</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          type="text"
          placeholder="关键词过滤"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="settings-btn" onClick={() => void refreshFull()}>
          刷新
        </button>
      </div>

      {error && <div className="save-error">{error}</div>}

      <pre className="logs-viewer">{logs || "暂无日志"}</pre>
    </section>
  );
}