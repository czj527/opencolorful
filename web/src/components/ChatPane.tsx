import type { SessionView, ModelSummary } from "../lib/types.js";
import type { ChatState } from "../features/chat/chat-state.js";
import { MessageList } from "../features/chat/MessageList.jsx";
import { MessageComposer } from "../features/chat/MessageComposer.jsx";
import { MessageSquare } from "lucide-react";

interface ChatPaneProps {
  readonly session: SessionView | null;
  readonly chat: ChatState;
  readonly models: ModelSummary[];
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onCompact: () => void;
  readonly onToggleThinking: () => void;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly sseConnected: boolean;
}

export function ChatPane({
  session,
  chat,
  models,
  onSend,
  onAbort,
  onCompact,
  onToggleThinking,
  onSelectModel,
  sseConnected,
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
  // 历史消息只显示到当前流开始之前；streaming 消息由 chat reducer 管理
  const historyEntries = session.messageEntries;

  return (
    <main className="app-chat" role="main" aria-label="聊天区域">
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{session.title}</span>
          <span style={{ marginLeft: 8, color: "var(--text-secondary)", fontSize: "12px" }}>
            {session.toolMode} · {session.thinkingLevel}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <select
            aria-label="选择模型"
            value={session.model ? models.findIndex((m) => m.providerId === session.model!.providerId && m.modelId === session.model!.modelId) : -1}
            onChange={(e) => {
              const index = Number(e.target.value);
              const model = models[index];
              if (model) onSelectModel(model.providerId, model.modelId);
            }}
            style={{ padding: "4px 6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 12, maxWidth: 200 }}
          >
            <option value={-1}>未选择模型</option>
            {models.map((m, index) => (
              <option key={`${m.providerId}/${m.modelId}`} value={index}>
                {m.providerId}/{m.modelId}
              </option>
            ))}
          </select>
          <span
            className={`status-dot ${sseConnected ? "online" : "stopped"}`}
            title={sseConnected ? "事件流已连接" : "事件流未连接"}
            aria-label={sseConnected ? "事件流已连接" : "事件流未连接"}
          />
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
      />

      <MessageComposer
        disabled={false}
        running={running}
        onSend={onSend}
        onAbort={onAbort}
        onCompact={onCompact}
      />
    </main>
  );
}
