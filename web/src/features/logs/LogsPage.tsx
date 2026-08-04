import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Activity, AlertTriangle, Database, FileText, Gauge, HardDrive, ShieldCheck } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { ObservabilityHealthResponse } from "../../lib/types.js";
import { Badge } from "../../components/ui/index.js";
import { navigateToWorkspace } from "../../app/page-router.js";
import { ActivityView } from "./activity-view.js";
import { ErrorsView } from "./errors-view.js";
import { AuditView } from "./audit-view.js";
import { PerformanceView } from "./performance-view.js";
import { RawLogsView } from "./raw-logs-view.js";
import { ExportView } from "./export-view.js";
import { isDiskNearLimit } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface LogsPageProps {
  readonly api: ApiClient;
}

type TabId = "activity" | "errors" | "audit" | "performance" | "raw" | "export";

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly icon: ReactNode }> = [
  { id: "activity", label: "活动", icon: <Activity size={14} /> },
  { id: "errors", label: "错误", icon: <AlertTriangle size={14} /> },
  { id: "audit", label: "安全审计", icon: <ShieldCheck size={14} /> },
  { id: "performance", label: "性能", icon: <Gauge size={14} /> },
  { id: "raw", label: "原始日志", icon: <FileText size={14} /> },
  { id: "export", label: "诊断导出", icon: <Database size={14} /> },
];

export function LogsPage({ api }: LogsPageProps) {
  const [tab, setTab] = useState<TabId>("activity");
  const [health, setHealth] = useState<ObservabilityHealthResponse | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  // URL 预筛选：/logs?plugin=<pluginId>（插件详情「查看相关日志」入口）→ 活动 tab 初始搜索值；
  // 无 plugin 参数时为空，行为与之前一致
  const [pluginFilter] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("plugin") ?? "";
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getObservabilityHealth();
        if (!cancelled) {
          setHealth(result);
          setHealthUnavailable(false);
        }
      } catch {
        // Agent Server 未运行（502）或可观测性未初始化（503）→ 显示 degraded 徽标
        if (!cancelled) setHealthUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const healthSummary = useCallback((): ReactNode => {
    if (health === null) {
      return <Badge variant="danger" className={styles.healthBadge ?? ""}>健康不可用</Badge>;
    }
    const badges: ReactNode[] = [];
    if (health.logger.degraded) {
      badges.push(<Badge key="degraded" variant="warning" className={styles.healthBadge ?? ""}>logger 降级</Badge>);
    }
    if (health.logger.dropped > 0) {
      badges.push(<Badge key="dropped" variant="danger" className={styles.healthBadge ?? ""}>事件丢弃 {health.logger.dropped}</Badge>);
    }
    if (health.logger.failed > 0) {
      badges.push(<Badge key="failed" variant="warning" className={styles.healthBadge ?? ""}>写入失败 {health.logger.failed}</Badge>);
    }
    if (health.spool.pendingSegments > 0) {
      badges.push(<Badge key="spool" variant="warning" className={styles.healthBadge ?? ""}>spool 待处理 {health.spool.pendingSegments}</Badge>);
    }
    if (isDiskNearLimit(health.logger.disk.totalBytes)) {
      badges.push(<Badge key="disk" variant="warning" className={styles.healthBadge ?? ""}>磁盘占用高</Badge>);
    }
    badges.push(<Badge key="epoch" variant="info" className={styles.healthBadge ?? ""}>Epoch {health.auditEpoch}</Badge>);
    return <>{badges}</>;
  }, [health]);

  return (
    <main className={styles.page} data-page="logs">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={navigateToWorkspace} data-testid="logs-back">
          ← 返回聊天
        </button>
        <h1 className={styles.title}>日志工作页</h1>
        <div className={styles.healthBar} data-testid="logs-health">
          {healthUnavailable ? <Badge variant="danger" className={styles.healthBadge ?? ""}>健康不可用</Badge> : healthSummary()}
        </div>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="日志视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`logs-tab-${item.id}`}
            className={tab === item.id ? styles.tabActive : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {tab === "activity" && <ActivityView api={api} initialSearch={pluginFilter} />}
        {tab === "errors" && <ErrorsView api={api} />}
        {tab === "audit" && <AuditView api={api} auditEpoch={health?.auditEpoch ?? null} />}
        {tab === "performance" && <PerformanceView api={api} />}
        {tab === "raw" && <RawLogsView api={api} />}
        {tab === "export" && <ExportView api={api} health={health} />}
      </div>
    </main>
  );
}
