import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Coins,
  HelpCircle,
  Loader2,
  Play,
  Power,
  Timer,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { SubagentRunStatus, SubagentThreadStatus } from "../../lib/types.js";
import {
  canRequestParentAction,
  currentPhaseLine,
  formatRelativeTime,
  formatRunElapsed,
  formatRunUsage,
  latestRun,
  modelLabel,
  runLabel,
  subagentResultDispositionText,
  subagentRunStatusText,
  subagentThreadStatusText,
} from "./subagent-format.js";
import type { SubagentCardData } from "./use-subagent-threads.js";
import styles from "./SubagentCard.module.css";

export type SubagentParentRequestAction = "cancel" | "ask";

/** Run 状态 → 图标（§21.4 状态文案 + 图标；无语义循环等未证明文案） */
export const SUBAGENT_STATUS_ICONS: Readonly<Record<SubagentRunStatus, LucideIcon>> = {
  queued: Clock,
  starting: Play,
  running: Loader2,
  waiting_for_input: HelpCircle,
  cancelling: XCircle,
  succeeded: CheckCircle2,
  failed: AlertTriangle,
  cancelled: Ban,
  timed_out: Timer,
  interrupted: Power,
  budget_exhausted: Coins,
};

function statusIconFor(runStatus: SubagentRunStatus | null, threadStatus: SubagentThreadStatus): LucideIcon {
  if (runStatus !== null) return SUBAGENT_STATUS_ICONS[runStatus];
  return threadStatus === "closed" ? CheckCircle2 : Clock;
}

export interface SubagentCardProps {
  readonly card: SubagentCardData;
  readonly reducedMotion?: boolean;
  readonly onOpen: (threadId: SubagentCardData["threadId"]) => void;
  /** 只读请求：向主对话发结构化消息，不直接控制 Subagent（§21.1） */
  readonly onRequestParentAction: (
    threadId: SubagentCardData["threadId"],
    action: SubagentParentRequestAction,
    title: string,
  ) => void;
}

/** 卡片主体行（字段名 + 值），统一排版避免跳动 */
function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue} title={value}>{value}</span>
    </span>
  );
}

export function SubagentCard({ card, reducedMotion = false, onOpen, onRequestParentAction }: SubagentCardProps) {
  const { threadId, transcript, loading, error } = card;
  const thread = transcript?.thread ?? null;
  const runs = transcript?.runs ?? [];
  const run = latestRun(runs);
  const statusText = run !== null
    ? subagentRunStatusText(run.status)
    : thread !== null
      ? subagentThreadStatusText(thread.status)
      : "尚未运行";
  const StatusIcon = statusIconFor(run?.status ?? null, thread?.status ?? "open");
  const title = thread?.title ?? "Subagent";
  const artifactCount = transcript?.artifacts.length ?? 0;
  const canRequest = thread !== null && run !== null && canRequestParentAction(run);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(threadId);
    }
  };

  return (
    <article
      className={`subagent-card ${styles.card ?? ""}${reducedMotion ? ` ${styles.cardNoAnim ?? ""}` : ""}`}
      data-thread-id={threadId}
      data-status={run?.status ?? thread?.status ?? "unknown"}
      role="button"
      tabIndex={0}
      aria-label={`打开 Subagent 面板：${title}`}
      onClick={() => onOpen(threadId)}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <span className={styles.statusIcon} aria-hidden="true">
          <StatusIcon size={14} className={run !== null && (run.status === "running" || run.status === "starting") && !reducedMotion ? styles.spin ?? "" : ""} />
        </span>
        <span className={styles.title}>{title}</span>
        <span className={styles.statusText}>{statusText}</span>
      </div>

      {loading && (
        <div className={styles.loadingRow} data-testid={`subagent-card-loading-${threadId}`}>
          <Loader2 size={12} aria-hidden="true" /> 正在加载卡片…
        </div>
      )}
      {error !== null && !loading && (
        <div className={styles.errorRow} role="alert" data-testid={`subagent-card-error-${threadId}`}>
          {error}
        </div>
      )}

      {transcript !== null && (
        <div className={styles.body}>
          <Field label="Run" value={run !== null ? runLabel(run.ordinal) : "—"} />
          <Field
            label="模型"
            value={thread !== null ? modelLabel(thread.modelProviderId, thread.modelId) : "—"}
          />
          <Field
            label="阶段"
            value={run !== null ? (currentPhaseLine(run) || "—") : "—"}
          />
          <Field
            label="已运行"
            value={run !== null ? formatRunElapsed(run) : "—"}
          />
          <Field
            label="Token"
            value={run !== null ? formatRunUsage(run) : "—"}
          />
          <Field
            label="最近活动"
            value={thread !== null ? formatRelativeTime(thread.lastActivityAt) : "—"}
          />
          <Field label="Artifacts" value={String(artifactCount)} />
          {run?.result !== null && run?.result !== undefined && (
            <span className={styles.resultLine} data-testid={`subagent-card-result-${threadId}`}>
              <span className={styles.resultDisposition}>
                {subagentResultDispositionText(run.result.disposition)}
              </span>
              <span className={styles.resultSummary}>{run.result.summary}</span>
            </span>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {canRequest && (
          <>
            <button
              type="button"
              className={styles.requestButton}
              onClick={(event) => {
                event.stopPropagation();
                onRequestParentAction(threadId, "cancel", title);
              }}
              data-testid={`subagent-request-cancel-${threadId}`}
            >
              请主 Agent 取消
            </button>
            <button
              type="button"
              className={styles.requestButton}
              onClick={(event) => {
                event.stopPropagation();
                onRequestParentAction(threadId, "ask", title);
              }}
              data-testid={`subagent-request-ask-${threadId}`}
            >
              补充信息
            </button>
          </>
        )}
        {!canRequest && (
          <span className={styles.readonlyHint}>只读卡片 · 点击查看详情</span>
        )}
      </div>
    </article>
  );
}

export interface SubagentCardListProps {
  readonly cards: readonly SubagentCardData[];
  readonly loading?: boolean;
  readonly reducedMotion?: boolean;
  readonly onOpen: (threadId: SubagentCardData["threadId"]) => void;
  readonly onRequestParentAction: (
    threadId: SubagentCardData["threadId"],
    action: SubagentParentRequestAction,
    title: string,
  ) => void;
}

/**
 * 主对话卡片区：多卡片按创建位置（createdAt 升序）稳定展示，
 * 实时更新只改字段值，不重排不跳动（§21.1）。
 */
export function SubagentCardList({
  cards,
  loading = false,
  reducedMotion = false,
  onOpen,
  onRequestParentAction,
}: SubagentCardListProps) {
  if (cards.length === 0) return null;
  return (
    <section
      className={styles.list}
      aria-label="Subagent 任务卡片"
      data-testid="subagent-card-list"
    >
      <div className={styles.listHeader}>
        <span>Subagent 任务</span>
        {loading && <span className={styles.listHint}>同步中…</span>}
      </div>
      <div className={styles.grid}>
        {cards.map((card) => (
          <SubagentCard
            key={card.threadId}
            card={card}
            reducedMotion={reducedMotion}
            onOpen={onOpen}
            onRequestParentAction={onRequestParentAction}
          />
        ))}
      </div>
    </section>
  );
}
