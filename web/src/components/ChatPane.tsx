import type { SessionView, ModelSummary } from "../lib/types.js";
import type { ChatState } from "../features/chat/chat-state.js";
import { MessageList } from "../features/chat/MessageList.jsx";
import { MessageComposer } from "../features/chat/MessageComposer.jsx";
import { MessageSquare, Settings } from "lucide-react";
import "../features/chat/chat.css";

interface ChatPaneProps {
  readonly session: SessionView | null;
  readonly chat: ChatState;
  readonly models: ModelSummary[];
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onToggleThinking: (id: string) => void;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly onToolModeChange?: (mode: string) => void;
  readonly onThinkingLevelChange?: (level: string) => void;
  readonly sseConnected: boolean;
  readonly onSettingsClick?: () => void;
  readonly reducedMotion?: boolean;
  readonly showThinking?: boolean;
  readonly showToolCalls?: boolean;
}

export function ChatPane({
  session,
  chat,
  models,
  onSend,
  onAbort,
  onToggleThinking,
  onSelectModel,
  sseConnected,
  onSettingsClick,
  reducedMotion,
  onToolModeChange,
  onThinkingLevelChange,
  showThinking = true,
  showToolCalls = true,
}: ChatPaneProps) {
  if (!session) {
    return (
      <main className="app-chat" role="main" aria-label="聊天区域">
        <div className="empty-state" style={{ flex: 1 }}>
          <MessageSquare size={32} strokeWidth={1.5} aria-hidden="true" style={{ opacity: 0.4 }} />
          <div style={{ fontSize: "16px", fontWeight: 500 }}>选择一个会话开始对话</div>
          <div style={{ fontSize: "13px" }}>从左侧面板选择或创建新会话</div>
        </div>
      </main>
    );
  }

  const running = chat.status === "running";
  const historyEntries = session.messageEntries;

  return (
    <main className="app-chat" role="main" aria-label="聊天区域">
      {/* 标题栏：Session 名 + SSE 状态 + 设置 */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{session.title}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <span
            className={`status-dot ${sseConnected ? "online" : "stopped"}`}
            title={sseConnected ? "事件流已连接" : "事件流未连接"}
            aria-label={sseConnected ? "事件流已连接" : "事件流未连接"}
          />
          {onSettingsClick && (
            <button type="button" className="icon-button" onClick={onSettingsClick} title="设置中心" aria-label="设置中心">
              <Settings size={14} />
            </button>
          )}
        </div>
      </div>

      {chat.error && (
        <div role="alert" style={{ padding: "6px 16px", background: "rgba(255,74,74,0.1)", color: "var(--danger)", fontSize: 13, borderBottom: "1px solid var(--border-color)" }}>
          {chat.error}
        </div>
      )}

      <MessageList
        messages={chat.messages}
        historyEntries={historyEntries}
        timeline={chat.timeline}
        toolCalls={chat.toolCalls}
        planItems={chat.planItems}
        attachments={chat.attachments}
        thinking={chat.thinking}
        collapsedThinkingBlocks={chat.collapsedThinkingBlocks}
        onToggleThinking={onToggleThinking}
        recovering={!sseConnected && running}
        reducedMotion={reducedMotion ?? false}
        showThinking={showThinking ?? true}
        showToolCalls={showToolCalls ?? true}
        turnUsages={chat.turnUsages}
      />

      <MessageComposer
        disabled={false}
        running={running}
        onSend={onSend}
        onAbort={onAbort}
        models={models}
        selectedModel={session.model}
        onSelectModel={onSelectModel}
        toolMode={session.toolMode}
        onToolModeChange={onToolModeChange ?? (() => {})}
        thinkingLevel={session.thinkingLevel}
        onThinkingLevelChange={onThinkingLevelChange ?? (() => {})}
        contextUsage={chat.contextUsage}
        usageTotals={chat.usageTotals}
        cacheHitRate={chat.cacheHitRate}
      />
    </main>
  );
}
