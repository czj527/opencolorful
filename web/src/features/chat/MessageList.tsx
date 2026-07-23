import { Brain } from "lucide-react";
import type {
  Attachment,
  ChatMessage,
  ChatTimelineItem,
  PlanItem as PlanItemData,
  ToolCall,
} from "./chat-state.js";
import { ToolCallItem } from "./ToolCallItem.jsx";
import { PlanList } from "./PlanItem.jsx";
import { UiProjection } from "./UiProjection.jsx";
import { renderSafeMarkdown } from "./safe-markdown.jsx";

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly historyEntries: readonly { role: "user" | "assistant"; content: string }[];
  readonly timeline: readonly ChatTimelineItem[];
  readonly toolCalls: ReadonlyMap<string, ToolCall>;
  readonly planItems: readonly PlanItemData[];
  readonly attachments: readonly Attachment[];
  readonly thinking: string;
  readonly thinkingCollapsed: boolean;
  readonly onToggleThinking: () => void;
  readonly recovering: boolean;
}

function sameMessage(
  left: { readonly role: string; readonly content: string },
  right: { readonly role: string; readonly content: string },
): boolean {
  return left.role === right.role && left.content === right.content;
}

function MessageBlock({ message }: { readonly message: ChatMessage }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        background: message.role === "user" ? "var(--bg-tertiary)" : "transparent",
        borderRadius: 6,
        maxWidth: "85%",
        alignSelf: message.role === "user" ? "flex-end" : "flex-start",
        wordBreak: "break-word",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>
        {message.role === "user" ? "你" : "助手"}
      </div>
      {message.role === "assistant"
        ? renderSafeMarkdown(message.content)
        : <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>}
      {message.streaming && <span className="streaming-cursor" aria-hidden="true">▍</span>}
    </div>
  );
}

export function MessageList({
  messages,
  historyEntries,
  timeline,
  toolCalls,
  planItems,
  attachments,
  thinking,
  thinkingCollapsed,
  onToggleThinking,
  recovering,
}: MessageListProps) {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const timelineMessageIds = new Set(
    timeline.filter((item) => item.kind === "message").map((item) => item.id),
  );

  // Session JSONL 历史与实时状态会短暂重叠。当前 turn 的消息由 timeline 渲染，
  // 从历史中移除对应的最新条目，既避免重复，也保留工具卡片的事件顺序。
  const matchedHistoryIndexes = new Set<number>();
  let historyCursor = historyEntries.length - 1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind !== "message") continue;
    const message = messagesById.get(item.id);
    if (!message) continue;
    for (let historyIndex = historyCursor; historyIndex >= 0; historyIndex -= 1) {
      if (sameMessage(historyEntries[historyIndex]!, message)) {
        matchedHistoryIndexes.add(historyIndex);
        historyCursor = historyIndex - 1;
        break;
      }
    }
  }

  const visibleHistory = historyEntries.filter((_, index) => !matchedHistoryIndexes.has(index));
  const untimedMessages = messages.filter((message) => !timelineMessageIds.has(message.id));
  const representedUntimed = new Set<number>();
  const missingUntimedMessages: ChatMessage[] = [];
  for (const message of untimedMessages) {
    const index = visibleHistory.findIndex((entry, candidateIndex) =>
      !representedUntimed.has(candidateIndex) && sameMessage(entry, message));
    if (index === -1) {
      missingUntimedMessages.push(message);
    } else {
      representedUntimed.add(index);
    }
  }

  const renderTimelineItem = (item: ChatTimelineItem) => {
    if (item.kind === "message") {
      const message = messagesById.get(item.id);
      return message ? <MessageBlock key={`message-${item.id}`} message={message} /> : null;
    }
    if (item.kind === "thinking") {
      if (!thinking) return null;
      return (
        <div
          key={item.id}
          style={{
            padding: "6px 10px",
            background: "var(--bg-tertiary)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <button
            type="button"
            onClick={onToggleThinking}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: 0, fontSize: 12 }}
            aria-expanded={!thinkingCollapsed}
          >
            <Brain size={12} aria-hidden="true" />
            思考过程 {thinkingCollapsed ? "（点击展开）" : "（点击收起）"}
          </button>
          {!thinkingCollapsed && (
            <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{thinking}</div>
          )}
        </div>
      );
    }
    if (item.kind === "tool") {
      const toolCall = toolCalls.get(item.id);
      return toolCall ? <ToolCallItem key={`tool-${item.id}`} toolCall={toolCall} /> : null;
    }
    if (item.kind === "plan") {
      return planItems.length > 0 ? <PlanList key={item.id} items={planItems} /> : null;
    }
    const attachment = attachments.find((candidate) => candidate.attachmentId === item.id);
    return attachment
      ? <UiProjection key={`attachment-${item.id}`} attachments={[attachment]} />
      : null;
  };

  return (
    <div className="chat-messages" data-testid="message-list">
      {recovering && (
        <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--warning)", textAlign: "center" }}>
          连接中断，正在恢复事件流…
        </div>
      )}

      {visibleHistory.map((entry, index) => (
        <MessageBlock
          key={`history-${index}`}
          message={{
            id: `history-${index}`,
            role: entry.role,
            content: entry.content,
            timestamp: "",
            streaming: false,
          }}
        />
      ))}

      {missingUntimedMessages.map((message) => (
        <MessageBlock key={`untimed-${message.id}`} message={message} />
      ))}

      {timeline.map(renderTimelineItem)}
    </div>
  );
}
