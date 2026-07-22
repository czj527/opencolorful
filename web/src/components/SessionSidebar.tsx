import { useState } from "react";
import type { SessionView } from "../lib/types.js";
import { Plus, Archive, Search, FolderOpen } from "lucide-react";

interface SessionSidebarProps {
  readonly sessions: SessionView[];
  readonly activeSessionId: string | null;
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
  readonly onCreate: (title: string, cwd: string) => void;
  readonly onArchive: (id: string) => void;
  readonly onToggle: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  collapsed,
  onSelect,
  onCreate,
  onArchive,
  onToggle,
}: SessionSidebarProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCwd, setNewCwd] = useState("");
  const [search, setSearch] = useState("");

  if (collapsed) {
    return null;
  }

  const filtered = search.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase()))
    : sessions;

  const handleCreate = () => {
    const title = newTitle.trim();
    const cwd = newCwd.trim();
    if (!title || !cwd) return;
    onCreate(title, cwd);
    setNewTitle("");
    setNewCwd("");
    setShowCreate(false);
  };

  return (
    <aside className="app-sidebar-left" role="complementary" aria-label="会话列表">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <button
          className="icon-button"
          onClick={() => setShowCreate(!showCreate)}
          type="button"
          aria-label="新建会话"
          title="新建会话"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 6 }}>
        <Search size={12} aria-hidden="true" style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
        <input
          type="text"
          placeholder="搜索会话"
          aria-label="搜索会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, background: "none", border: "none", color: "var(--text-primary)", fontSize: 12, outline: "none" }}
        />
      </div>

      {showCreate && (
        <div style={{ padding: 12, borderBottom: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="text"
            placeholder="会话标题"
            aria-label="会话标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
          />
          <input
            type="text"
            placeholder="工作目录（如 D:\projects\demo）"
            aria-label="工作目录"
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
          />
          <button
            className="icon-button primary"
            onClick={handleCreate}
            disabled={!newTitle.trim() || !newCwd.trim()}
            type="button"
          >
            创建
          </button>
        </div>
      )}

      <div className="sidebar-content">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={24} strokeWidth={1.5} aria-hidden="true" style={{ opacity: 0.4 }} />
            <div>{search ? "无匹配会话" : "暂无会话"}</div>
            {!search && <div style={{ fontSize: "12px" }}>点击 + 创建新会话</div>}
          </div>
        ) : (
          filtered.map((session) => (
            <div
              key={session.id}
              className={`sidebar-item${session.id === activeSessionId ? " active" : ""}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelect(session.id); }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                <div className="sidebar-item-title" style={{ flex: 1, minWidth: 0 }}>{session.title}</div>
                <button
                  className="icon-button"
                  style={{ padding: 2, border: "none", flexShrink: 0 }}
                  onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
                  type="button"
                  aria-label={`归档会话 ${session.title}`}
                  title="归档会话"
                >
                  <Archive size={12} aria-hidden="true" />
                </button>
              </div>
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
