import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { ApiClient } from "../../lib/api-client.js";
import type { AuditRow } from "../../lib/types.js";
import { Badge, Button, EmptyState, Select, Spinner } from "../../components/ui/index.js";
import { formatTime, parsePayload, payloadPreview } from "./logs-format.js";
import styles from "./LogsPage.module.css";

export interface AuditViewProps {
  readonly api: ApiClient;
  /** 当前 ledger epoch（来自 health），用于 epoch 下拉过滤 */
  readonly auditEpoch: number | null;
}

const PAGE_SIZE = 50;

function epochOptions(auditEpoch: number | null): number[] {
  if (auditEpoch === null || auditEpoch <= 0) return [];
  const options: number[] = [];
  for (let epoch = auditEpoch; epoch >= Math.max(1, auditEpoch - 2); epoch -= 1) {
    options.push(epoch);
  }
  return options;
}

function decisionBadge(decision: string): ReactNode {
  const variant = decision === "allowed"
    ? "success"
    : decision === "denied"
      ? "danger"
      : decision === "required"
        ? "warning"
        : "info";
  return <Badge variant={variant}>{decision}</Badge>;
}

export function AuditView({ api, auditEpoch }: AuditViewProps) {
  const [epoch, setEpoch] = useState("");
  const [rows, setRows] = useState<readonly AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<AuditRow | null>(null);
  const [showFullPayload, setShowFullPayload] = useState(false);

  const load = useCallback(async (cursor: string | null) => {
    if (cursor === null) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const page = await api.queryAudit(
        { ...(epoch !== "" ? { epoch: Number(epoch) } : {}) },
        cursor,
        PAGE_SIZE,
      );
      if (cursor === null) setRows(page.items); else setRows((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审计记录加载失败");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [api, epoch]);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section className={styles.tabPane} aria-label="安全审计">
      <div className={styles.filterBar}>
        <label className={styles.filterLabel}>
          Ledger Epoch
          <Select value={epoch} onChange={(value) => setEpoch(value)} aria-label="Epoch 过滤" className={styles.epochSelect ?? ""}>
            <option value="">全部</option>
            {epochOptions(auditEpoch).map((option) => <option key={option} value={String(option)}>Epoch {option}</option>)}
          </Select>
        </label>
        <span className={styles.muted}>审计账本只读，无编辑或删除入口。</span>
      </div>

      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <Button size="sm" onClick={() => void load(null)}><RefreshCw size={14} /> 重试</Button>
        </div>
      )}
      {loading ? (
        <div className={styles.loadingRow}><Spinner /> 正在加载审计记录…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="暂无审计记录"
          description="高风险操作与策略决策会以只读形式记录在这里。"
        />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>Action</th>
                  <th>Decision</th>
                  <th className={styles.colActor}>Actor</th>
                  <th className={styles.colEpoch}>Epoch</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={expanded?.id === row.id ? styles.rowActive : undefined}
                    onClick={() => setExpanded(expanded?.id === row.id ? null : row)}
                  >
                    <td className={styles.colTime}>{formatTime(row.recordedAt)}</td>
                    <td><span className={styles.eventName}>{row.action}</span></td>
                    <td>{decisionBadge(row.decision)}</td>
                    <td className={styles.colActor}>{row.actorKind}:{row.actorId}</td>
                    <td className={styles.colEpoch}>{row.ledgerEpoch}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.rowAction}
                        aria-label={`查看 ${row.action} 审计详情`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpanded(expanded?.id === row.id ? null : row);
                        }}
                      >
                        {expanded?.id === row.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor !== null && (
            <div className={styles.loadMoreRow}>
              <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void load(nextCursor)}>
                加载更多
              </Button>
            </div>
          )}
        </>
      )}

      {expanded !== null && (
        <div className={styles.detailPanel} data-testid="audit-detail" role="region" aria-label="审计详情">
          <div className={styles.detailHead}>
            <h3>{expanded.action} <Badge variant="default">Epoch {expanded.ledgerEpoch}</Badge></h3>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(null)}>关闭</Button>
          </div>
          <dl className={styles.detailGrid}>
            <div><dt>记录时间</dt><dd>{formatTime(expanded.recordedAt)}</dd></div>
            <div><dt>Action</dt><dd>{expanded.action}</dd></div>
            <div><dt>Decision</dt><dd>{decisionBadge(expanded.decision)}</dd></div>
            <div><dt>reasonCode</dt><dd>{expanded.reasonCode ?? "—"}</dd></div>
            <div><dt>Actor</dt><dd>{expanded.actorKind}:{expanded.actorId}</dd></div>
            <div><dt>归属 Agent</dt><dd>{expanded.ownerAgentId ?? "—"}</dd></div>
            <div><dt>Session</dt><dd>{expanded.sessionId ?? "—"}</dd></div>
            <div><dt>traceId</dt><dd><code className={styles.codeInline}>{expanded.traceId}</code></dd></div>
            <div><dt>eventId</dt><dd><code className={styles.codeInline}>{expanded.eventId}</code></dd></div>
          </dl>
          <AuditPayloadView row={expanded} showFull={showFullPayload} onToggle={() => setShowFullPayload(!showFullPayload)} />
        </div>
      )}
    </section>
  );
}

function AuditPayloadView({ row, showFull, onToggle }: {
  readonly row: AuditRow;
  readonly showFull: boolean;
  readonly onToggle: () => void;
}) {
  const payload = parsePayload(row.payloadJson);
  const preview = payloadPreview(payload);
  return (
    <div className={styles.payloadBlock}>
      <div className={styles.payloadHead}>
        <strong>Payload（脱敏）</strong>
        {preview.truncated && (
          <Button variant="ghost" size="sm" onClick={onToggle}>{showFull ? "收起" : "展开全文"}</Button>
        )}
      </div>
      <pre className={styles.payloadPre}>
        {showFull ? (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)) : preview.text}
      </pre>
    </div>
  );
}
