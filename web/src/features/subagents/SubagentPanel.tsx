// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：右侧只读 Subagent 面板（plans/phase-14.md §21.2 / §21.5）
//
// - Header：标题 / 状态 / 模型 / 关闭面板按钮；
// - Run strip：Run 序号 / 时间 / 用量 / 结果（可切换；默认全部）；
// - Transcript timeline：TaskBrief、可见 assistant 文本、Tool/Plugin/Skill
//   行为、主 Agent Steer、input_required、终态 Result（SubagentTimeline）；
// - 实时 follow：SSE `subagent:<threadId>` 流（useSubagentPanel），断线重连
//   Last-Event-ID/sinceSeq 游标，stale → reset + snapshot 重建，不重复追加；
//   默认 follow latest；用户上滚后不强制回底，显示「有新内容」提示；
// - Artifacts：名称 / 类型 / 哈希摘要 / 受控下载；
// - Technical summary：snapshotId / workspace access / 冻结工作目录 / limits /
//   reasonCode / 日志链接（/logs?subagent=）；
// - 无 steer/cancel/retry/grant 控件（用户只能观察，§二 / §3.2）；
// - 桌面端右侧栏；移动端（rightNarrow）全屏只读 sheet/page（§21.5）；
// - 当前主对话切换后面板关闭（由调用方处理），不显示旧 Session Thread（§21.2）。
// ═══════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ExternalLink, Loader2, X } from "lucide-react";
import type {
  SubagentOwnership,
  SubagentRunId,
  SubagentThreadId,
  SubagentTranscriptMessage,
} from "../../lib/types.js";
import { navigateToLogsSubagent } from "../../app/page-router.js";
import { SubagentArtifacts, SubagentTimeline } from "./SubagentTimeline.jsx";
import {
  formatClock,
  formatRunUsage,
  latestRun,
  modelLabel,
  runLabel,
  subagentResultDispositionText,
  subagentRunStatusText,
} from "./subagent-format.js";
import { useSubagentPanel } from "./use-subagent-panel.js";
import styles from "./SubagentPanel.module.css";

export interface SubagentPanelProps {
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly api: import("../../lib/api-client.js").ApiClient;
  readonly enabled: boolean;
  /** 移动端（rightNarrow）：全屏只读 sheet/page（§21.5） */
  readonly mobile?: boolean;
  readonly reducedMotion?: boolean;
  readonly onClose: () => void;
}

export function SubagentPanel({
  threadId,
  ownership,
  api,
  enabled,
  mobile = false,
  reducedMotion = false,
  onClose,
}: SubagentPanelProps) {
  const panel = useSubagentPanel({ api, threadId, ownership, enabled });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [hasNewContent, setHasNewContent] = useState(false);

  const transcript = panel.transcript;
  const thread = transcript?.thread ?? null;
  const runs = transcript?.runs ?? [];
  const run = latestRun(runs);
  const selectedRun = panel.selectedRunId !== null
    ? runs.find((candidate) => candidate.runId === panel.selectedRunId) ?? null
    : null;

  // follow latest：默认贴底；用户上滚后不强制回底，出现「有新内容」提示
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null) return undefined;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = distance < 24;
      atBottomRef.current = atBottom;
      if (atBottom) setHasNewContent(false);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // 新消息/新 Run 到达：贴底时自动跟随，否则显示「有新内容」
  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
    } else if ((transcript?.messages.length ?? 0) > 0 || panel.tools.size > 0) {
      setHasNewContent(true);
    }
  }, [transcript?.messages.length, transcript?.runs.length, panel.tools.size]);

  const scrollToLatest = () => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
    atBottomRef.current = true;
    setHasNewContent(false);
  };

  const visibleMessages: readonly SubagentTranscriptMessage[] = panel.selectedRunId === null
    ? (transcript?.messages ?? [])
    : (transcript?.messages.filter((message) => message.runId === panel.selectedRunId) ?? []);

  const statusText = run !== null
    ? subagentRunStatusText(run.status)
    : thread !== null
      ? "尚未运行"
      : "加载中";

  const technicalSummary = thread !== null && run !== null ? (
    <details className={styles.techSummary} data-testid="subagent-technical-summary">
      <summary>技术信息</summary>
      <dl className={styles.techList}>
        <div className={styles.techRow}>
          <dt>Snapshot</dt>
          <dd>{run.snapshotId ?? "—"}</dd>
        </div>
        <div className={styles.techRow}>
          <dt>工作区访问</dt>
          <dd>{thread.capabilityCeiling.workspaceAccess}</dd>
        </div>
        <div className={styles.techRow}>
          <dt>工作目录</dt>
          <dd title={thread.workspaceCwd}>{thread.workspaceCwd}</dd>
        </div>
        <div className={styles.techRow}>
          <dt>模型来源</dt>
          <dd>{thread.modelSource}</dd>
        </div>
        <div className={styles.techRow}>
          <dt>预算</dt>
          <dd>
            迭代 {run.limits.maxModelIterations} · 工具 {run.limits.maxToolCalls} · Token {run.limits.maxTotalTokens}
          </dd>
        </div>
        {run.reasonCode !== null && (
          <div className={styles.techRow}>
            <dt>原因</dt>
            <dd>{run.reasonCode}</dd>
          </div>
        )}
      </dl>
      <button
        type="button"
        className={styles.logsLink}
        onClick={() => navigateToLogsSubagent(threadId)}
        data-testid="subagent-open-logs"
      >
        <ExternalLink size={12} aria-hidden="true" /> 查看相关日志
      </button>
    </details>
  ) : null;

  return (
    <div
      className={`subagent-panel ${styles.panel ?? ""}${mobile ? ` ${styles.panelMobile ?? ""}` : ""}${reducedMotion ? ` ${styles.panelNoAnim ?? ""}` : ""}`}
      role="region"
      aria-label={`Subagent 面板：${thread?.title ?? threadId}`}
      data-thread-id={threadId}
      data-mobile={mobile ? "true" : undefined}
      data-reduced-motion={reducedMotion ? "true" : undefined}
    >
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <div className={styles.headerTitle} title={thread?.title}>{thread?.title ?? "Subagent"}</div>
          <div className={styles.headerMeta}>
            <span className={styles.headerStatus} data-testid="subagent-panel-status">
              {statusText}
            </span>
            {thread !== null && (
              <span className={styles.headerModel} data-testid="subagent-panel-model">
                {modelLabel(thread.modelProviderId, thread.modelId)}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="关闭面板"
          data-testid="subagent-panel-close"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {/* Run strip：序号 / 时间 / 用量 / 结果，可切换 */}
      {transcript !== null && (
        <div className={styles.runStrip} role="tablist" aria-label="Run 选择" data-testid="subagent-run-strip">
          <button
            type="button"
            role="tab"
            aria-selected={panel.selectedRunId === null}
            className={`${styles.runTab}${panel.selectedRunId === null ? ` ${styles.runTabActive ?? ""}` : ""}`}
            onClick={() => panel.selectRun(null)}
          >
            全部
          </button>
          {runs.map((candidate) => (
            <button
              key={candidate.runId}
              type="button"
              role="tab"
              aria-selected={panel.selectedRunId === candidate.runId}
              className={`${styles.runTab}${panel.selectedRunId === candidate.runId ? ` ${styles.runTabActive ?? ""}` : ""}`}
              onClick={() => panel.selectRun(candidate.runId)}
              data-testid={`run-tab-${candidate.ordinal}`}
              title={`${runLabel(candidate.ordinal)} · ${formatRunUsage(candidate)} · ${subagentRunStatusText(candidate.status)}`}
            >
              {runLabel(candidate.ordinal)}
              <span className={styles.runTabMeta}>
                {formatClock(candidate.createdAt)}
                {candidate.result !== null ? ` · ${subagentResultDispositionText(candidate.result.disposition)}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className={styles.scrollArea} ref={scrollRef} data-testid="subagent-panel-scroll">
        {panel.loading && (
          <div className={styles.loading} data-testid="subagent-panel-loading">
            <Loader2 size={14} aria-hidden="true" /> 正在加载面板…
          </div>
        )}
        {panel.error !== null && (
          <div className={styles.error} role="alert" data-testid="subagent-panel-error">
            {panel.error}
            <button type="button" className={styles.retryButton} onClick={onClose}>
              关闭
            </button>
          </div>
        )}
        {!panel.loading && panel.error === null && transcript !== null && (
          <>
            {panel.hasOlder && (
              <button
                type="button"
                className={styles.loadOlder}
                onClick={panel.loadOlder}
                disabled={panel.loadingOlder}
                data-testid="subagent-load-older"
              >
                {panel.loadingOlder ? "加载中…" : "加载更早消息"}
              </button>
            )}
            <SubagentTimeline
              messages={visibleMessages}
              tools={[...panel.tools.values()]}
              taskBrief={transcript.taskBrief}
            />
            <SubagentArtifacts
              artifacts={transcript.artifacts}
              contentUrl={(artifactId) => api.getSubagentArtifactContentUrl(artifactId, ownership)}
            />
            {selectedRun !== null && selectedRun.result !== null && (
              <div className={styles.selectedRunResult}>
                当前 Run 结果：{subagentResultDispositionText(selectedRun.result.disposition)}
              </div>
            )}
            {technicalSummary}
          </>
        )}
        {!panel.loading && panel.error === null && transcript === null && (
          <div className={styles.empty}>该 Subagent 暂无内容</div>
        )}
      </div>

      <footer className={styles.footer}>
        <span className={styles.streamStatus} data-testid="subagent-stream-status">
          {panel.streamConnected ? "实时已连接" : "连接断开，正在重连…"}
        </span>
        <span className={styles.readonlyBadge}>只读 · 不可直接控制</span>
      </footer>

      {hasNewContent && (
        <button
          type="button"
          className={styles.newContent}
          onClick={scrollToLatest}
          data-testid="subagent-new-content"
        >
          <ArrowDown size={12} aria-hidden="true" /> 有新内容
        </button>
      )}
    </div>
  );
}
