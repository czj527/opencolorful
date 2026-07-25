import { memo, useMemo } from "react";
import type { ChatMessage } from "./chat-state.js";

/** 从用户消息内容提取摘要（前 20 字） */
function extractSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 20)}…`;
}

/** 相对时间格式化 */
function formatRelativeTime(timestamp: string): string {
  if (!timestamp) return "";
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth} 个月前`;
}

export interface TimelineTurn {
  readonly messageId: string;
  readonly anchorId: string;
  readonly index: number;
  readonly summary: string;
  readonly relativeTime: string;
}

/** 从消息列表派生轮次节点（纯客户端，每条用户消息是一个轮次起点） */
export function deriveTurns(messages: readonly ChatMessage[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    index += 1;
    turns.push({
      messageId: message.id,
      anchorId: `turn-${message.id}`,
      index,
      summary: extractSummary(message.content),
      relativeTime: formatRelativeTime(message.timestamp),
    });
  }
  return turns;
}

interface ChatTimelineNavProps {
  readonly messages: readonly ChatMessage[];
  readonly activeAnchor: string | null;
  readonly onSelectTurn: (anchorId: string) => void;
}

export const ChatTimelineNav = memo(function ChatTimelineNav({
  messages,
  activeAnchor,
  onSelectTurn,
}: ChatTimelineNavProps) {
  const turns = useMemo(() => deriveTurns(messages), [messages]);

  if (turns.length === 0) return null;

  return (
    <nav className="chat-timeline-nav" aria-label="对话时间线" data-testid="chat-timeline-nav">
      <div className="chat-timeline-track">
        {turns.map((turn) => (
          <button
            key={turn.messageId}
            type="button"
            className={`chat-timeline-node${activeAnchor === turn.anchorId ? " active" : ""}`}
            onClick={() => onSelectTurn(turn.anchorId)}
            aria-label={`第 ${turn.index} 轮：${turn.summary}`}
            data-testid={`timeline-node-${turn.messageId}`}
          >
            <span className="chat-timeline-dot" aria-hidden="true" />
            <span className="chat-timeline-label">
              <span className="chat-timeline-index">{turn.index}</span>
              <span className="chat-timeline-summary">{turn.summary}</span>
              {turn.relativeTime && (
                <span className="chat-timeline-time">{turn.relativeTime}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
});
