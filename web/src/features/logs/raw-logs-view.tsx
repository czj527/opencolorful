import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Play, Pause, RefreshCw } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { DiagnosticTail } from "../../lib/types.js";
import { Button, EmptyState, Select, Spinner } from "../../components/ui/index.js";
import { formatBytes } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface RawLogsViewProps {
  readonly api: ApiClient;
}

const LINE_OPTIONS = [100, 200, 500] as const;

const PROCESS_OPTIONS = [
  { value: "server", label: "server（Agent Server）" },
  { value: "supervisor", label: "supervisor" },
] as const;

const FILE_OPTIONS = [
  { value: "main", label: "main（主日志）" },
  { value: "debug", label: "debug（调试日志）" },
] as const;

export function RawLogsView({ api }: RawLogsViewProps) {
  const [process, setProcess] = useState<"server" | "supervisor">("server");
  const [file, setFile] = useState<"main" | "debug">("main");
  const [lines, setLines] = useState<number>(200);
  const [tail, setTail] = useState<DiagnosticTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const viewerRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async (scrollToBottom: boolean) => {
    setError(null);
    try {
      const result = await api.diagnosticTail(process, file, lines);
      setTail(result);
      if (scrollToBottom && viewerRef.current !== null) {
        viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "原始日志加载失败");
    }
  }, [api, process, file, lines]);

  const handleLoad = useCallback(() => {
    setFollow(false);
    void load(false);
  }, [load]);

  // follow 模式：每 3 秒自动刷新并保持滚动到底部
  useEffect(() => {
    if (!follow) return undefined;
    void load(true);
    const timer = window.setInterval(() => void load(true), 3_000);
    return () => window.clearInterval(timer);
  }, [follow, load]);

  return (
    <section className={styles.tabPane} aria-label="原始日志">
      <div className={styles.filterBar}>
        <label className={styles.filterLabel}>
          进程
          <Select value={process} onChange={(value) => setProcess(value as "server" | "supervisor")} aria-label="日志进程" className={styles.rawSelect ?? ""}>
            {PROCESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
        <label className={styles.filterLabel}>
          文件
          <Select value={file} onChange={(value) => setFile(value as "main" | "debug")} aria-label="日志文件" className={styles.rawSelect ?? ""}>
            {FILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
        <label className={styles.filterLabel}>
          行数
          <Select value={String(lines)} onChange={(value) => setLines(Number(value) as 100 | 200 | 500)} aria-label="日志行数" className={styles.rawSelect ?? ""}>
            {LINE_OPTIONS.map((option) => <option key={option} value={String(option)}>{option}</option>)}
          </Select>
        </label>
        <Button size="sm" loading={loading} onClick={() => void handleLoad()}><RefreshCw size={14} /> 加载</Button>
        {follow ? (
          <Button size="sm" variant="ghost" onClick={() => setFollow(false)}><Pause size={14} /> 暂停</Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setFollow(true)}><Play size={14} /> 继续跟随</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => { setTail(null); setError(null); }}><Eraser size={14} /> 清空视图</Button>
      </div>

      {tail !== null && (
        <p className={styles.muted} data-testid="tail-meta">
          {tail.file} · {tail.lines} 行 · 文件 {formatBytes(tail.totalBytes)}
          {follow ? " · 跟随中（每 3 秒刷新）" : ""}
        </p>
      )}

      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <Button size="sm" onClick={() => void handleLoad()}>重试</Button>
        </div>
      )}

      {tail === null && loading ? (
        <div className={styles.loadingRow}><Spinner /> 正在加载原始日志…</div>
      ) : tail === null ? (
        <EmptyState
          title="尚未加载原始日志"
          description="选择进程、文件与行数后点击「加载」。日志只读取文件尾部，不会整文件载入。"
        />
      ) : (
        <pre
          ref={viewerRef}
          className={styles.logViewer}
          data-testid="log-viewer"
        >
          {tail?.tail.length ? tail.tail.join("\n") : "（日志为空）"}
        </pre>
      )}
    </section>
  );
}
