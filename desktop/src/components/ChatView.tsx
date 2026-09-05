import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileDiff,
  FileText,
  ListChecks,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { ChatEvent, ChatMessage, EventKind, TimelineItem } from "../mock-data.js";
import { useLocalPrefs } from "../data/local-prefs.js";
import type { DesktopDataSource } from "../data/source.js";
import { correlationShortRef, type ErrorCorrelation } from "../errors.js";

const eventIcons: Record<EventKind, LucideIcon> = {
  thinking: CircleCheck,
  tool: Wrench,
  file: FileDiff,
  plan: ListChecks,
  approval: CircleAlert,
  subagent: Bot,
  memory: BookOpen,
  status: CircleAlert,
};

const NEW_THREAD = "new";

/** A5：错误状态行的 projector 标题（data/projector.ts markPromptFailed / error / turn.failed 分支） */
const ERROR_ROW_TITLES: readonly string[] = ["运行错误", "发送失败"];

function isErrorRow(item: TimelineItem): boolean {
  return item.type === "event" && item.kind === "status" && ERROR_ROW_TITLES.includes(item.title);
}

const MessageRow = memo(function MessageRow({ message }: { readonly message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={`msg msg-${message.role}`}>
      <div className="msg-head">
        <span className="msg-author">{isUser ? "你" : message.author ?? "Agent"}</span>
        <span className="msg-meta">{message.meta}</span>
      </div>
      <div className="msg-body">
        {message.body}
        {message.streaming && <span className="stream-caret" aria-hidden="true" />}
      </div>
    </article>
  );
});

function EventDetail({ event, onOpenDiff }: { readonly event: ChatEvent; readonly onOpenDiff: () => void }) {
  if (event.kind === "tool" && event.tools) {
    return (
      <div className="detail-list">
        {event.tools.map((tool) => (
          <div className="tool-row" key={`${tool.name}-${tool.target}`}>
            <span className="tool-name">{tool.name}</span>
            <span className="tool-target">{tool.target}</span>
            <span className={`tool-status s-${tool.status}`}>
              {tool.status === "succeeded" ? "完成" : tool.status === "running" ? "运行中" : "失败"}
            </span>
            {tool.duration && <span className="tool-duration">{tool.duration}</span>}
          </div>
        ))}
      </div>
    );
  }
  if (event.kind === "file" && event.files) {
    return (
      <div className="detail-stack">
        {event.detail && <p className="detail-text">{event.detail}</p>}
        <div className="detail-list">
          {event.files.map((file) => (
            <div className="file-row" key={file.path}>
              <FileText size={13} />
              <span className="file-path">{file.path}</span>
              <span className="file-note">{file.note}</span>
              <span className="file-count"><b>+{file.additions}</b> <i>−{file.deletions}</i></span>
            </div>
          ))}
        </div>
        <button type="button" className="inline-action" onClick={onOpenDiff}>
          <FileDiff size={13} />在右侧审查
        </button>
      </div>
    );
  }
  if (event.kind === "plan" && event.plan) {
    return (
      <div className="detail-list">
        {event.plan.map((step) => (
          <div className="plan-row" key={step.label}>
            <span className={`plan-mark plan-${step.status}`}>
              {step.status === "done" ? "✓" : step.status === "active" ? "→" : "·"}
            </span>
            <strong>{step.label}</strong>
            <small>{step.status === "done" ? "已完成" : step.status === "active" ? "进行中" : "排队中"}</small>
          </div>
        ))}
      </div>
    );
  }
  if (event.kind === "subagent" && event.subagent) {
    const sub = event.subagent;
    return (
      <div className="detail-stack">
        <div className="subagent-facts">
          <span>{sub.name}</span><span>{sub.model}</span>
          <span className={sub.status === "completed" ? "s-succeeded" : "s-running"}>
            {sub.status === "completed" ? "已完成" : sub.status === "running" ? "运行中" : "等待中"}
          </span>
        </div>
        <p className="detail-text">{sub.task}</p>
        <p className="detail-text subagent-result"><Check size={12} /> {sub.result}</p>
      </div>
    );
  }
  if (event.kind === "memory" && event.recalled) {
    return (
      <div className="detail-list">
        {event.recalled.map((item) => (
          <div className="recall-row" key={item}><BookOpen size={12} /><span>{item}</span></div>
        ))}
      </div>
    );
  }
  return event.detail ? <p className="detail-text">{event.detail}</p> : null;
}

interface EventRowProps {
  readonly event: ChatEvent;
  readonly onOpenDiff: () => void;
  /** A5：仅错误状态行收到诊断引用与跳转动作（其余行传 null/undefined） */
  readonly errorCorrelation?: ErrorCorrelation | null;
  readonly onOpenLogs?: (correlation: ErrorCorrelation) => void;
}

const EventRow = memo(function EventRow({ event, onOpenDiff, errorCorrelation, onOpenLogs }: EventRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [approval, setApproval] = useState<"pending" | "approved" | "denied">("pending");
  const Icon = eventIcons[event.kind];
  const hasDetail = Boolean(
    event.detail || event.tools?.length || event.files?.length || event.plan?.length || event.subagent || event.recalled?.length,
  );
  const showCorrelation = errorCorrelation !== undefined && errorCorrelation !== null && onOpenLogs !== undefined;

  return (
    <article className={`event event-${event.kind}`}>
      <button
        type="button"
        className="event-summary"
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        <span className="event-icon" aria-hidden="true"><Icon size={14} strokeWidth={1.8} /></span>
        <span className="event-copy">
          <span className="event-title">{event.title}</span>
          <strong>{event.summary}</strong>
        </span>
        <span className="event-meta">
          <span>{event.meta}</span>
          {hasDetail && <ChevronRight size={13} className={expanded ? "is-rotated" : ""} />}
        </span>
      </button>
      {showCorrelation && (
        // A5：诊断引用行（复用 approval-actions 的缩进布局，不新增样式）；
        // 引用仅含 id 与时间戳，完整 traceId 在 title 中可复制
        <div className="approval-actions">
          <code title={errorCorrelation.traceId}>诊断引用 {correlationShortRef(errorCorrelation)}</code>
          <button type="button" className="inline-action" onClick={() => onOpenLogs(errorCorrelation)}>
            在日志中查看
          </button>
        </div>
      )}
      {event.approval && (
        approval === "pending" ? (
          <div className="approval-actions">
            <button type="button" className="btn btn-primary" onClick={() => setApproval("approved")}>
              <Check size={13} />允许一次
            </button>
            <button type="button" className="btn" onClick={() => setApproval("denied")}>
              <X size={13} />拒绝
            </button>
            <span className="approval-scope">{event.approval.action} · {event.approval.scope}</span>
          </div>
        ) : (
          <div className={`approval-result ${approval === "approved" ? "s-succeeded" : "s-failed"}`}>
            {approval === "approved" ? <Check size={13} /> : <X size={13} />}
            {approval === "approved" ? "已允许" : "已拒绝"} · {event.approval.action}
          </div>
        )
      )}
      {expanded && hasDetail && (
        <div className="event-detail"><EventDetail event={event} onOpenDiff={onOpenDiff} /></div>
      )}
    </article>
  );
});

interface TimelineProps {
  readonly items: readonly TimelineItem[];
  readonly onOpenDiff: () => void;
  /** A5：错误行的诊断关联引用（未解析/无错误行为 null）；每行非错误项不传 */
  readonly errorCorrelation?: ErrorCorrelation | null;
  readonly onOpenLogs?: (correlation: ErrorCorrelation) => void;
}

export function Timeline({ items, onOpenDiff, errorCorrelation, onOpenLogs }: TimelineProps) {
  return (
    <div className="chat-column" aria-live="polite">
      {items.map((item) =>
        item.type === "message"
          ? <MessageRow key={item.id} message={item} />
          : <EventRow
              key={item.id}
              event={item}
              onOpenDiff={onOpenDiff}
              {...(isErrorRow(item) ? { errorCorrelation: errorCorrelation ?? null, onOpenLogs } : {})}
            />,
      )}
    </div>
  );
}

interface ChatViewProps {
  readonly source: DesktopDataSource;
  readonly threadId: string;
  readonly onOpenDiff: () => void;
  /** 快照 streaming 布尔的最小回传通道：仅布尔翻转时 App 壳重渲染（setState 本身稳定） */
  readonly onStreamingChange: (streaming: boolean) => void;
  /** A5：错误行「在日志中查看」动作（App 负责跳转日志页并携带引用预填） */
  readonly onOpenLogs?: (correlation: ErrorCorrelation) => void;
}

/**
 * 会话时间线容器：items/streaming 的 subscribeChat 订阅下沉在这里，
 * 流式重渲染留在聊天列内部，不波及 App 壳（App 只经 onStreamingChange 收到布尔翻转）。
 */
export function ChatView({ source, threadId, onOpenDiff, onStreamingChange, onOpenLogs }: ChatViewProps) {
  const [items, setItems] = useState<readonly TimelineItem[]>([]);
  const prefs = useLocalPrefs();

  useEffect(() => {
    if (threadId === NEW_THREAD) {
      setItems([]);
      onStreamingChange(false);
      return;
    }
    return source.subscribeChat(threadId, (snapshot) => {
      setItems(snapshot.items);
      onStreamingChange(snapshot.streaming);
    });
  }, [source, threadId, onStreamingChange]);

  // 设置 → 对话显示：仅过滤本地渲染，不影响事件流与回放数据
  const visible = useMemo(() => items.filter((item) => {
    if (item.type !== "event") return true;
    if (!prefs.showThinking && item.kind === "thinking") return false;
    if (!prefs.showToolCalls && item.kind === "tool") return false;
    return true;
  }), [items, prefs.showThinking, prefs.showToolCalls]);

  /* ---- A5：错误行诊断关联 ----
   * 出现错误行后按会话解析一次关联引用：优先取该会话最新 failed 记录的 per-turn
   * traceId（turn.started/turn.failed/provider.* 同 trace，服务端在 SSE 发出失败
   * 终态前已 durable 落库，这里只读消费）；查询失败/无记录时回退会话 id——会话路由
   * 自身以 sessionId 作为 traceId 盖章（routes/sessions.ts trace 三元组）。
   * 引用只含 id 与时间戳，不含任何请求/响应载荷。
   */
  const errorRowId = useMemo(() => {
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const item = visible[index];
      if (item !== undefined && isErrorRow(item)) return item.id;
    }
    return null;
  }, [visible]);

  const [correlation, setCorrelation] = useState<ErrorCorrelation | null>(null);
  const resolvedFor = useRef<string | null>(null);

  useEffect(() => {
    if (threadId === NEW_THREAD || errorRowId === null) return;
    if (resolvedFor.current === errorRowId) return;
    resolvedFor.current = errorRowId;
    let cancelled = false;
    source.queryActivity({ sessionId: threadId, status: "failed" }, null, 10)
      .then((result) => {
        if (cancelled) return;
        const trace = result.rows.find((row) => row.traceId !== "")?.traceId;
        setCorrelation(trace !== undefined
          ? { traceId: trace, origin: "server", at: new Date().toISOString() }
          : { traceId: threadId, origin: "server", at: new Date().toISOString() });
      })
      .catch(() => {
        if (!cancelled) setCorrelation({ traceId: threadId, origin: "server", at: new Date().toISOString() });
      });
    return () => {
      cancelled = true;
    };
  }, [source, threadId, errorRowId]);

  return <Timeline items={visible} onOpenDiff={onOpenDiff} errorCorrelation={correlation} onOpenLogs={onOpenLogs} />;
}
