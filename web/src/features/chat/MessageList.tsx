import { memo, useEffect } from "react";
import { Brain, ArrowDown, Terminal, Archive } from "lucide-react";
import type { TokenUsage } from "../../lib/types.js";
import type {
  Attachment,
  ChatMessage,
  ChatTimelineItem,
  CommandCard,
  CompactionCard,
  PlanItem as PlanItemData,
  ToolCall,
} from "./chat-state.js";
import { ToolCallItem } from "./ToolCallItem.jsx";
import { PlanList } from "./PlanItem.jsx";
import { UiProjection } from "./UiProjection.jsx";
import { renderSafeMarkdown } from "./safe-markdown.jsx";
import { useChatScroll, type UseChatScrollResult } from "./use-chat-scroll.js";
import { sameMessage } from "./timeline-turns.js";

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly historyEntries: readonly { role: "user" | "assistant"; content: string }[];
  readonly timeline: readonly ChatTimelineItem[];
  readonly toolCalls: ReadonlyMap<string, ToolCall>;
  readonly planItems: readonly PlanItemData[];
  readonly attachments: readonly Attachment[];
  readonly thinking: string;
  readonly collapsedThinkingBlocks: ReadonlySet<string>;
  readonly onToggleThinking: (id: string) => void;
  readonly recovering: boolean;
  readonly reducedMotion: boolean;
  readonly showThinking?: boolean;
  readonly showToolCalls?: boolean;
  /** 本 turn 各 assistant 消息的用量（messageId → usage） */
  readonly turnUsages?: ReadonlyMap<string, TokenUsage>;
  /** 本地命令结果卡片（cardId → 卡片） */
  readonly commandCards?: ReadonlyMap<string, CommandCard>;
  /** 压缩卡片（cardId → 卡片） */
  readonly compactionCards?: ReadonlyMap<string, CompactionCard>;
  /** 外部传入的 scroll 状态（提升层级时由 ChatPane 统一管理） */
  readonly scroll?: UseChatScrollResult;
}

function formatTurnUsage(usage: TokenUsage): string {
  let line = `↑${usage.input} ↓${usage.output}`;
  if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
    line += ` R${usage.cacheRead} W${usage.cacheWrite}`;
  }
  return line;
}

export const MessageBlock = memo(function MessageBlock({
  message,
  turnUsage,
}: {
  readonly message: ChatMessage;
  readonly turnUsage?: TokenUsage;
}) {
  const anchorAttr = message.role === "user" ? { "data-anchor": `turn-${message.id}` } : {};
  return (
    <div
      {...anchorAttr}
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
      {message.role === "assistant" && !message.streaming
        ? renderSafeMarkdown(message.content)
        : <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>}
      {message.streaming && <span className="streaming-cursor" aria-hidden="true">▍</span>}
      {message.role === "assistant" && !message.streaming && turnUsage && (
        <div className="turn-usage-line" data-testid={`turn-usage-${message.id}`}>
          {formatTurnUsage(turnUsage)}
        </div>
      )}
    </div>
  );
}, (previous, next) =>
  previous.message.role === next.message.role &&
  previous.message.content === next.message.content &&
  previous.message.streaming === next.message.streaming &&
  previous.turnUsage === next.turnUsage,
);

/** 本地命令结果卡片（弱化样式，与消息区分） */
function CommandCardBlock({ card }: { readonly card: CommandCard }) {
  return (
    <div
      className={`command-card${card.tone === "error" ? " command-card-error" : ""}`}
      data-testid={`command-card-${card.id}`}
    >
      <div className="command-card-title">
        <Terminal size={12} aria-hidden="true" />
        {card.title}
      </div>
      <div className="command-card-body">
        {card.lines.map((line, index) => (
          <div key={index} className="command-card-line">{line}</div>
        ))}
      </div>
    </div>
  );
}

/** 压缩结果卡片 */
function CompactionCardBlock({ card }: { readonly card: CompactionCard }) {
  return (
    <div
      className={`compaction-card${card.status === "failed" ? " compaction-card-failed" : ""}`}
      data-testid={`compaction-card-${card.id}`}
    >
      <div className="compaction-card-title">
        <Archive size={12} aria-hidden="true" />
        {card.status === "compacting"
          ? "正在压缩会话上下文…"
          : card.status === "failed"
            ? "压缩未完成"
            : "上下文已压缩"}
      </div>
      {card.status !== "compacting" && (
        <div className="compaction-card-body">
          {(card.tokensBefore !== null || card.tokensAfter !== null) && (
            <div className="compaction-card-line">
              {card.tokensBefore ?? "?"} → {card.tokensAfter ?? "?"} tokens
            </div>
          )}
          {card.summary !== null && (
            <div className="compaction-card-line compaction-card-summary">{card.summary}</div>
          )}
          {card.errorMessage !== null && (
            <div className="compaction-card-line compaction-card-error">{card.errorMessage}</div>
          )}
        </div>
      )}
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
  collapsedThinkingBlocks,
  onToggleThinking,
  recovering,
  reducedMotion,
  showThinking = true,
  showToolCalls = true,
  turnUsages,
  commandCards,
  compactionCards,
  scroll,
}: MessageListProps) {
  const internalScroll = useChatScroll(reducedMotion);
  const { containerRef, hasUnread, scrollToLatest, autoScrollIfAtBottom } = scroll ?? internalScroll;
  const messagesById = new Map(messages.map((message) => [message.id, message]));

  // 每次 messages/timeline 变化后执行自动滚动
  useEffect(() => {
    autoScrollIfAtBottom();
  }, [
    messages,
    timeline,
    toolCalls,
    thinking,
    planItems,
    attachments,
    autoScrollIfAtBottom,
  ]);
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
      if (!message) return null;
      const turnUsage = turnUsages?.get(message.id);
      return (
        <MessageBlock
          key={`message-${item.id}`}
          message={message}
          {...(turnUsage !== undefined ? { turnUsage } : {})}
        />
      );
    }
    if (item.kind === "thinking") {
      if (!showThinking) return null;
      const thinkingText = item.content ?? thinking;
      if (!thinkingText) return null;
      const collapsed = collapsedThinkingBlocks.has(item.id);
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
            onClick={() => onToggleThinking(item.id)}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: 0, fontSize: 12 }}
            aria-expanded={!collapsed}
          >
            <Brain size={12} aria-hidden="true" />
            思考过程 {collapsed ? "（点击展开）" : "（点击收起）"}
          </button>
          {!collapsed && (
            <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{thinkingText}</div>
          )}
        </div>
      );
    }
    if (item.kind === "tool") {
      if (!showToolCalls) return null;
      const toolCall = toolCalls.get(item.id);
      return toolCall ? <ToolCallItem key={`tool-${item.id}`} toolCall={toolCall} /> : null;
    }
    if (item.kind === "plan") {
      return planItems.length > 0 ? <PlanList key={item.id} items={planItems} /> : null;
    }
    if (item.kind === "command") {
      const card = commandCards?.get(item.id);
      return card ? <CommandCardBlock key={`command-${item.id}`} card={card} /> : null;
    }
    if (item.kind === "compaction") {
      const card = compactionCards?.get(item.id);
      return card ? <CompactionCardBlock key={`compaction-${item.id}`} card={card} /> : null;
    }
    const attachment = attachments.find((candidate) => candidate.attachmentId === item.id);
    return attachment
      ? <UiProjection key={`attachment-${item.id}`} attachments={[attachment]} />
      : null;
  };

  return (
    <div className="chat-messages" data-testid="message-list" ref={containerRef}>
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

      {hasUnread && (
        <button
          type="button"
          className="icon-button scroll-to-latest"
          onClick={scrollToLatest}
          aria-label="跳到最新消息"
          data-testid="scroll-to-latest"
          style={{
            position: "sticky",
            bottom: 8,
            alignSelf: "center",
            zIndex: 5,
          }}
        >
          <ArrowDown size={14} /> 跳到最新
        </button>
      )}
    </div>
  );
}
