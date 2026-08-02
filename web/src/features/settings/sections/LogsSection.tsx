import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../../lib/api-client.js";
import type { LogTail, ObservabilityPreferences } from "../../../lib/types.js";
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
  /** 评审 P1-7：Phase 11 可观测性偏好（诊断级别/保留/预算）读写在 Settings 内 */
  readonly api: ApiClient;
}

const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export function LogsSection(props: LogsSectionProps) {
  const [logs, setLogs] = useState("");
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Phase 11 偏好（评审 P1-7） ────────────────────────────────
  const [prefs, setPrefs] = useState<ObservabilityPreferences | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [prefsSaved, setPrefsSaved] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const loadPrefs = useCallback(async () => {
    try {
      const loaded = await props.api.getObservabilityPreferences();
      setPrefs(loaded);
      setPrefsError(null);
    } catch (cause) {
      setPrefsError(cause instanceof Error ? cause.message : "偏好加载失败");
    }
  }, [props.api]);

  useEffect(() => {
    void loadPrefs();
  }, [loadPrefs]);

  const patchPrefs = useCallback(<K extends keyof ObservabilityPreferences>(key: K, value: ObservabilityPreferences[K]) => {
    setPrefs((current) => (current === null ? current : { ...current, [key]: value }));
    setPrefsSaved(null);
  }, []);

  const handleSavePrefs = useCallback(async () => {
    if (prefs === null) return;
    setSavingPrefs(true);
    setPrefsSaved(null);
    try {
      await props.api.saveObservabilityPreferences(prefs);
      setPrefsSaved("可观测性偏好已保存");
    } catch (cause) {
      setPrefsError(cause instanceof Error ? cause.message : "偏好保存失败");
    } finally {
      setSavingPrefs(false);
    }
  }, [prefs, props.api]);

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

  const retentionDays = (key: "debug" | "main"): string =>
    prefs === null ? "" : String(prefs.diagnosticRetentionDays[key]);
  const activityDays = (key: "routine" | "notable"): string =>
    prefs === null ? "" : String(prefs.activityRetentionDays[key]);
  const mib = (bytes: number): string => String(Math.round(bytes / (1024 * 1024)));

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

      {/* ── Phase 11 可观测性偏好（评审 P1-7） ───────────────────── */}
      <fieldset className={styles.prefsFieldset} data-testid="observability-prefs">
        <legend>可观测性偏好（重启后生效）</legend>
        {prefs === null && prefsError === null && <p className={styles.entryHint}>正在加载偏好…</p>}
        {prefsError !== null && <p className={styles.error} role="alert">{prefsError}</p>}
        {prefs !== null && (
          <div className={styles.prefsGrid}>
            <label className={styles.prefsItem}>
              诊断日志级别
              <Select
                value={prefs.diagnosticLevel}
                onChange={(value) => patchPrefs("diagnosticLevel", value as ObservabilityPreferences["diagnosticLevel"])}
                aria-label="诊断日志级别"
              >
                {LEVEL_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </Select>
            </label>
            <label className={styles.prefsItem}>
              debug 保留天数（1-60）
              <input
                type="number" min={1} max={60}
                value={retentionDays("debug")}
                onChange={(event) => patchPrefs("diagnosticRetentionDays", { ...prefs.diagnosticRetentionDays, debug: clampInt(event.target.value, 1, 60, 7) })}
                aria-label="debug 日志保留天数"
              />
            </label>
            <label className={styles.prefsItem}>
              main 保留天数（1-365）
              <input
                type="number" min={1} max={365}
                value={retentionDays("main")}
                onChange={(event) => patchPrefs("diagnosticRetentionDays", { ...prefs.diagnosticRetentionDays, main: clampInt(event.target.value, 1, 365, 30) })}
                aria-label="main 日志保留天数"
              />
            </label>
            <label className={styles.prefsItem}>
              单文件大小（MB，1-100）
              <input
                type="number" min={1} max={100}
                value={mib(prefs.diagnosticFileSizeBytes)}
                onChange={(event) => patchPrefs("diagnosticFileSizeBytes", clampInt(event.target.value, 1, 100, 10) * 1024 * 1024)}
                aria-label="日志文件大小"
              />
            </label>
            <label className={styles.prefsItem}>
              磁盘预算（MB，10-10240）
              <input
                type="number" min={10} max={10240}
                value={mib(prefs.diagnosticDiskBudgetBytes)}
                onChange={(event) => patchPrefs("diagnosticDiskBudgetBytes", clampInt(event.target.value, 10, 10240, 500) * 1024 * 1024)}
                aria-label="日志磁盘预算"
              />
            </label>
            <label className={styles.prefsItem}>
              routine 活动保留天数（7-730）
              <input
                type="number" min={7} max={730}
                value={activityDays("routine")}
                onChange={(event) => patchPrefs("activityRetentionDays", { ...prefs.activityRetentionDays, routine: clampInt(event.target.value, 7, 730, 180) })}
                aria-label="routine 活动保留天数"
              />
            </label>
            <label className={styles.prefsItem}>
              notable 活动保留天数（30-3650）
              <input
                type="number" min={30} max={3650}
                value={activityDays("notable")}
                onChange={(event) => patchPrefs("activityRetentionDays", { ...prefs.activityRetentionDays, notable: clampInt(event.target.value, 30, 3650, 730) })}
                aria-label="notable 活动保留天数"
              />
            </label>
            <label className={styles.prefsItem}>
              应急 spool 预算（MB，1-1024）
              <input
                type="number" min={1} max={1024}
                value={mib(prefs.emergencySpoolBudgetBytes)}
                onChange={(event) => patchPrefs("emergencySpoolBudgetBytes", clampInt(event.target.value, 1, 1024, 128) * 1024 * 1024)}
                aria-label="应急 spool 预算"
              />
            </label>
            <div className={styles.prefsActions}>
              <Button size="sm" onClick={() => void handleSavePrefs()} loading={savingPrefs}>保存偏好</Button>
              {prefsSaved !== null && <span className={styles.savedNote} role="status">{prefsSaved}</span>}
            </div>
          </div>
        )}
      </fieldset>

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

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
