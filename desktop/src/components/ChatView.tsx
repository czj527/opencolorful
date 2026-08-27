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
import { memo, useEffect, useState } from "react";

import type { ChatEvent, ChatMessage, EventKind, TimelineItem } from "../mock-data.js";
import type { DesktopDataSource } from "../data/source.js";

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

const EventRow = memo(function EventRow({ event, onOpenDiff }: { readonly event: ChatEvent; readonly onOpenDiff: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [approval, setApproval] = useState<"pending" | "approved" | "denied">("pending");
  const Icon = eventIcons[event.kind];
  const hasDetail = Boolean(
    event.detail || event.tools?.length || event.files?.length || event.plan?.length || event.subagent || event.recalled?.length,
  );

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

export function Timeline({ items, onOpenDiff }: { readonly items: readonly TimelineItem[]; readonly onOpenDiff: () => void }) {
  return (
    <div className="chat-column" aria-live="polite">
      {items.map((item) =>
        item.type === "message"
          ? <MessageRow key={item.id} message={item} />
          : <EventRow key={item.id} event={item} onOpenDiff={onOpenDiff} />,
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
}

/**
 * 会话时间线容器：items/streaming 的 subscribeChat 订阅下沉在这里，
 * 流式重渲染留在聊天列内部，不波及 App 壳（App 只经 onStreamingChange 收到布尔翻转）。
 */
export function ChatView({ source, threadId, onOpenDiff, onStreamingChange }: ChatViewProps) {
  const [items, setItems] = useState<readonly TimelineItem[]>([]);

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

  return <Timeline items={items} onOpenDiff={onOpenDiff} />;
}
