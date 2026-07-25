import type { SessionView, ModelSummary, AgentView } from "../lib/types.js";
import type { ChatState } from "../features/chat/chat-state.js";
import { MessageList } from "../features/chat/MessageList.jsx";
import { MessageComposer } from "../features/chat/MessageComposer.jsx";
import { AgentSelector } from "../features/chat/AgentSelector.js";
import { MessageSquare, Settings, Bot } from "lucide-react";
import "../features/chat/chat.css";

interface ChatPaneProps {
  readonly session: SessionView | null;
  readonly chat: ChatState;
  readonly models: ModelSummary[];
  readonly agents?: readonly AgentView[];
  readonly activeAgentId?: string | null;
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onCompact: () => void;
  readonly onToggleThinking: () => void;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly onSelectAgent?: (agentId: string | null) => void;
  readonly onToolModeChange?: (mode: string) => void;
  readonly onThinkingLevelChange?: (level: string) => void;
  readonly sseConnected: boolean;
  readonly onSettingsClick?: () => void;
  readonly reducedMotion?: boolean;
  readonly showThinking?: boolean;
  readonly showToolCalls?: boolean;
}

const TYPE_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  assistant: { bg: "rgba(74,158,255,0.15)", fg: "var(--accent)" },
  coding: { bg: "rgba(74,255,120,0.12)", fg: "var(--success)" },
  work: { bg: "rgba(255,166,74,0.15)", fg: "var(--warning)" },
};

export function ChatPane({
  session,
  chat,
  models,
  agents = [],
  activeAgentId = null,
  onSend,
  onAbort,
  onCompact,
  onToggleThinking,
  onSelectModel,
  onSelectAgent,
  sseConnected,
  onSettingsClick,
  reducedMotion,
  onToolModeChange,
  onThinkingLevelChange,
  showThinking = true,
  showToolCalls = true,
}: ChatPaneProps) {
  const activeAgent = agents.find((a) => a.identity.id === activeAgentId) ?? null;

  if (!session) {
    // 空状态：无会话选中时显示 Agent 欢迎卡片（若有 Agent）或默认欢迎
    if (activeAgent) {
      const colors = TYPE_BADGE_COLORS[activeAgent.identity.type] ?? { bg: "var(--bg-tertiary)", fg: "var(--text-secondary)" };
      return (
        <main className="app-chat" role="main" aria-label="聊天区域">
          <div className="agent-welcome-card">
            <div className="agent-welcome-icon">
              <Bot size={32} style={{ color: "var(--accent)" }} aria-hidden="true" />
            </div>
            <div className="agent-welcome-name">
              你好，我是 {activeAgent.identity.name}
            </div>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 8,
                background: colors.bg,
                color: colors.fg,
                textTransform: "uppercase",
                letterSpacing: "0.3px",
              }}
            >
              {activeAgent.identity.type}
            </span>
            <div className="agent-welcome-subtitle">
              从左侧面板选择或创建新会话开始对话
            </div>
          </div>
        </main>
      );
    }

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
      {/* 标题栏：Session 名 + Agent 选择器 + 设置 */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{session.title}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <AgentSelector
            agents={agents ?? []}
            activeAgentId={activeAgentId ?? null}
            onSelect={onSelectAgent ?? (() => {})}
          />
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
        thinkingCollapsed={chat.thinkingCollapsed}
        onToggleThinking={onToggleThinking}
        recovering={!sseConnected && running}
        reducedMotion={reducedMotion ?? false}
        showThinking={showThinking ?? true}
        showToolCalls={showToolCalls ?? true}
      />

      <MessageComposer
        disabled={false}
        running={running}
        onSend={onSend}
        onAbort={onAbort}
        onCompact={onCompact}
        models={models}
        selectedModel={session.model}
        onSelectModel={onSelectModel}
        toolMode={session.toolMode}
        onToolModeChange={onToolModeChange ?? (() => {})}
        thinkingLevel={session.thinkingLevel}
        onThinkingLevelChange={onThinkingLevelChange ?? (() => {})}
      />
    </main>
  );
}
