import { useCallback, useState, type ReactNode } from "react";
import { Download, PackageSearch } from "lucide-react";
import type { ApiClient, ApiClientError } from "../../lib/api-client.js";
import type { ObservabilityHealthResponse } from "../../lib/types.js";
import { Badge, Button, Card } from "../../components/ui/index.js";
import { formatBytes } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface ExportViewProps {
  readonly api: ApiClient;
  readonly health: ObservabilityHealthResponse | null;
}

const EXPORT_PARTS: Array<{ readonly name: string; readonly description: string }> = [
  { name: "导出 manifest", description: "导出时间、schema 版本、进程与包含项清单。" },
  { name: "脱敏 tail", description: "diagnostic 主/调试日志尾部（行数与字节双上限，凭据已二次脱敏）。" },
  { name: "失败 activity", description: "失败/降级事件的摘要记录，不含正文与敏感载荷。" },
  { name: "健康摘要", description: "logger/spool/磁盘占用与恢复统计快照。" },
  { name: "privacy manifest", description: "隐私清单：导出内容不包含认证信息、Session 正文与记忆原文。" },
];

export function ExportView({ api, health }: ExportViewProps) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ kind: "pending" | "ok" | "error"; message: string; detail?: string } | null>(null);

  const handleExport = useCallback(async () => {
    setBusy(true);
    setState(null);
    try {
      const result = await api.createObservabilityExport();
      setState({
        kind: "ok",
        message: "诊断包已生成（二次脱敏 + privacy manifest）",
        detail: `输出：${result.path}；rawPayload=${result.manifest.rawPayloadIncluded} factSources=${result.manifest.factSourcesIncluded} rawLogs=${result.manifest.rawLogsIncluded}；sections：${result.manifest.includedSections.join(", ")}`,
      });
    } catch (cause) {
      const status = typeof cause === "object" && cause !== null && "status" in cause
        ? (cause as ApiClientError).status
        : undefined;
      if (status === 404 || status === 405 || status === 501) {
        setState({ kind: "pending", message: "导出功能即将提供（T9）：诊断包生成端点尚未实现。" });
      } else {
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "导出请求失败" });
      }
    } finally {
      setBusy(false);
    }
  }, [api]);

  return (
    <section className={styles.tabPane} aria-label="诊断导出">
      <Card as="section" className={styles.exportCard ?? ""}>
        <div className={styles.cardTitle}>
          <h3><PackageSearch size={16} /> 诊断导出</h3>
          <Badge variant="info">T9</Badge>
        </div>
        <p className={styles.muted}>生成脱敏诊断包（support bundle），用于问题排查。导出内容经过二次脱敏并附带 privacy manifest，不包含认证信息、Session 正文、记忆原文与 Provider 凭据。</p>
        <ul className={styles.exportList}>
          {EXPORT_PARTS.map((part) => (
            <li key={part.name}>
              <strong>{part.name}</strong>
              <span>{part.description}</span>
            </li>
          ))}
        </ul>
        <div className={styles.row}>
          <Button size="sm" loading={busy} onClick={() => void handleExport()}><Download size={14} /> 生成导出</Button>
        </div>
        {state !== null && (
          <div className={state.kind === "pending" ? styles.pendingNote : state.kind === "ok" ? styles.okNote : styles.inlineError} role="status">
            <p>{state.message}</p>
            {state.detail !== undefined && <p className={styles.muted} data-testid="export-detail">{state.detail}</p>}
          </div>
        )}
      </Card>

      <HealthSummaryCard health={health} />
    </section>
  );
}

export function HealthSummaryCard({ health }: { readonly health: ObservabilityHealthResponse | null }): ReactNode {
  return (
    <div data-testid="health-summary-card">
      <Card as="section" className={styles.exportCard ?? ""}>
        <div className={styles.cardTitle}>
          <h3>当前健康摘要</h3>
          {health === null ? <Badge variant="danger">不可用</Badge> : health.logger.degraded ? <Badge variant="warning">降级</Badge> : <Badge variant="success">正常</Badge>}
        </div>
        {health === null ? (
          <p className={styles.muted}>健康摘要不可用：可观测性未初始化或 Agent Server 未运行。Agent Server 启动后可在此查看。</p>
        ) : (
          <dl className={styles.healthGrid}>
            <div><dt>Logger 丢弃</dt><dd>{health.logger.dropped}</dd></div>
            <div><dt>Logger 失败</dt><dd>{health.logger.failed}</dd></div>
            <div><dt>Logger 状态</dt><dd>{health.logger.degraded ? "降级" : "正常"}</dd></div>
            <div><dt>Spool 待处理</dt><dd>{health.spool.pendingSegments}</dd></div>
            <div><dt>Spool 写入失败</dt><dd>{health.spool.failedWrites}</dd></div>
            <div><dt>磁盘占用</dt><dd>{formatBytes(health.logger.disk.totalBytes)}</dd></div>
            <div><dt>Audit Epoch</dt><dd>{health.auditEpoch}</dd></div>
            <div><dt>恢复</dt><dd>中断 {health.recovery.lastInterrupted} · 导入 {health.recovery.lastSpoolImported}</dd></div>
          </dl>
        )}
      </Card>
    </div>
  );
}
