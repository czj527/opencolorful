import { Brain } from "lucide-react";
import type { ChatMessage, ToolCall, PlanItem as PlanItemData, Attachment } from "./chat-state.js";
import { ToolCallItem } from "./ToolCallItem.jsx";
import { PlanList } from "./PlanItem.jsx";
import { UiProjection } from "./UiProjection.jsx";
import { renderSafeMarkdown } from "./safe-markdown.jsx";

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly historyEntries: readonly { role: "user" | "assistant"; content: string }[];
  readonly toolCalls: ReadonlyMap<string, ToolCall>;
  readonly planItems: readonly PlanItemData[];
  readonly attachments: readonly Attachment[];
  readonly thinking: string;
  readonly thinkingCollapsed: boolean;
  readonly onToggleThinking: () => void;
  readonly recovering: boolean;
}

export function MessageList({
  messages,
  historyEntries,
  toolCalls,
  planItems,
  attachments,
  thinking,
  thinkingCollapsed,
  onToggleThinking,
  recovering,
}: MessageListProps) {
  const streamingMessage = messages.find((m) => m.streaming);

  return (
    <div className="chat-messages" data-testid="message-list">
      {recovering && (
        <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--warning)", textAlign: "center" }}>
          连接中断，正在恢复事件流…
        </div>
      )}

      {historyEntries.map((entry, i) => (
        <div
          key={`history-${i}`}
          style={{
            padding: "8px 12px",
            background: entry.role === "user" ? "var(--bg-tertiary)" : "transparent",
            borderRadius: 6,
            maxWidth: "85%",
            alignSelf: entry.role === "user" ? "flex-end" : "flex-start",
            wordBreak: "break-word",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>
            {entry.role === "user" ? "你" : "助手"}
          </div>
          {entry.role === "assistant"
            ? renderSafeMarkdown(entry.content)
            : <span style={{ whiteSpace: "pre-wrap" }}>{entry.content}</span>}
        </div>
      ))}

      {thinking && (
        <div
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
      )}

      {planItems.length > 0 && <PlanList items={planItems} />}

      {toolCalls.size > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Array.from(toolCalls.values()).map((toolCall) => (
            <ToolCallItem key={toolCall.toolCallId} toolCall={toolCall} />
          ))}
        </div>
      )}

      {streamingMessage && (
        <div
          style={{
            padding: "8px 12px",
            maxWidth: "85%",
            alignSelf: "flex-start",
            wordBreak: "break-word",
          }}
          data-testid="streaming-message"
        >
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>助手</div>
          {renderSafeMarkdown(streamingMessage.content)}
          <span className="streaming-cursor" aria-hidden="true">▍</span>
        </div>
      )}

      {attachments.length > 0 && <UiProjection attachments={attachments} />}
    </div>
  );
}
