import type { SessionView } from "../lib/types.js";
import { IconButton } from "./IconButton.jsx";

interface SessionSidebarProps {
  readonly sessions: SessionView[];
  readonly activeSessionId: string | null;
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onToggle: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  collapsed,
  onSelect,
  onCreate,
  onToggle,
}: SessionSidebarProps) {
  if (collapsed) {
    return null;
  }

  return (
    <aside className="app-sidebar-left" role="complementary" aria-label="会话列表">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <IconButton icon="+" label="新建会话" onClick={onCreate} title="新建会话" />
      </div>
      <div className="sidebar-content">
        {sessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div>暂无会话</div>
            <div style={{ fontSize: "12px" }}>点击 + 创建新会话</div>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-item${session.id === activeSessionId ? " active" : ""}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelect(session.id); }}
            >
              <div className="sidebar-item-title">{session.title}</div>
              <div className="sidebar-item-meta">
                {session.messages.length} 条消息 · {session.toolMode}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
