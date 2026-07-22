import type { SessionView } from "../lib/types.js";
import { IconButton } from "./IconButton.jsx";

interface ChatPaneProps {
  readonly session: SessionView | null;
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onCompact: () => void;
  readonly sending: boolean;
}

export function ChatPane({ session, onSend, onAbort, onCompact, sending }: ChatPaneProps) {
  if (!session) {
    return (
      <main className="app-chat" role="main" aria-label="聊天区域">
        <div className="empty-state" style={{ flex: 1 }}>
          <div className="empty-state-icon">💬</div>
          <div style={{ fontSize: "16px", fontWeight: 500 }}>选择一个会话开始对话</div>
          <div style={{ fontSize: "13px" }}>从左侧面板选择或创建新会话</div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-chat" role="main" aria-label="聊天区域">
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ fontWeight: 600 }}>{session.title}</span>
          <span style={{ marginLeft: 8, color: "var(--text-secondary)", fontSize: "12px" }}>
            {session.toolMode} · {session.thinkingLevel}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <IconButton icon="⏹" label="中断" onClick={onAbort} disabled={!sending} title="中断当前生成" />
          <IconButton icon="📦" label="压缩" onClick={onCompact} title="压缩会话上下文" />
        </div>
      </div>

      <div className="chat-messages">
        {session.messages.length === 0 ? (
          <div className="empty-state">
            <div>暂无消息，开始对话吧</div>
          </div>
        ) : (
          session.messages.map((msg, i) => (
            <div key={i} style={{ padding: "8px 12px", background: "var(--bg-tertiary)", borderRadius: 6, maxWidth: "80%" }}>
              {msg.slice(0, 200)}
            </div>
          ))
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          placeholder="输入消息..."
          aria-label="消息输入"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const target = e.target as HTMLTextAreaElement;
              if (target.value.trim()) {
                onSend(target.value.trim());
                target.value = "";
              }
            }
          }}
        />
        <IconButton
          icon="📤"
          label="发送"
          onClick={() => {
            const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input");
            if (textarea?.value.trim()) {
              onSend(textarea.value.trim());
              textarea.value = "";
            }
          }}
          variant="primary"
          title="发送消息"
        />
      </div>
    </main>
  );
}
