import { useState } from "react";
import type { SessionView, AgentView } from "../lib/types.js";
import { AgentSelector } from "../features/chat/AgentSelector.js";
import { AgentAvatar } from "../features/agents/AgentAvatar.js";
import { IconButton } from "./ui/index.js";
import { navigateToNewSession } from "../app/page-router.js";
import { Plus, Archive, ArchiveRestore, Search, FolderOpen } from "lucide-react";
import styles from "./SessionSidebar.module.css";

interface SessionSidebarProps {
  readonly sessions: SessionView[];
  readonly activeSessionId: string | null;
  readonly collapsed: boolean;
  readonly onSelect: (id: string) => void;
  readonly onArchive: (id: string) => void;
  readonly onUnarchive: (id: string) => void;
  readonly onToggle: () => void;
  readonly agents?: readonly AgentView[];
  readonly activeAgentId?: string | null;
  readonly onSelectAgent?: (id: string | null) => void;
}

const agentSectionClass = styles.agentSection ?? "";
const searchBarClass = styles.searchBar ?? "";
const searchIconClass = styles.searchIcon ?? "";
const searchInputClass = styles.searchInput ?? "";
const sessionRowClass = styles.sessionRow ?? "";
const sessionTitleClass = styles.sessionTitle ?? "";
const archiveBtnClass = styles.archiveBtn ?? "";
const archivedToggleClass = styles.archivedToggle ?? "";
const archivedGroupClass = styles.archivedGroup ?? "";
const archivedItemClass = styles.archivedItem ?? "";
const emptyHintClass = styles.emptyHint ?? "";
const emptyIconClass = styles.emptyIcon ?? "";

export function SessionSidebar({
  sessions,
  activeSessionId,
  collapsed,
  onSelect,
  onArchive,
  onUnarchive,
  onToggle,
  agents,
  activeAgentId,
  onSelectAgent,
}: SessionSidebarProps) {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const active = sessions.filter((s) => !s.archived);
  const archived = sessions.filter((s) => s.archived);
  const filtered = (list: SessionView[]) =>
    search.trim()
      ? list.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase()))
      : list;

  const resolveAgentName = (agentId: string | null): string | null => {
    if (!agentId || !agents) return null;
    const agent = agents.find((a) => a.identity.id === agentId);
    return agent?.identity.name ?? null;
  };

  const asideClass = `app-sidebar-left${collapsed ? " collapsed" : ""}`;

  return (
    <aside className={asideClass} role="complementary" aria-label="会话列表">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <IconButton
          icon={<Plus size={14} aria-hidden="true" />}
          label="新建会话"
          onClick={() => navigateToNewSession()}
        />
      </div>

      {agents && agents.length > 0 && onSelectAgent && (
        <div className={agentSectionClass}>
          <AgentSelector
            agents={agents}
            activeAgentId={activeAgentId ?? null}
            onSelect={onSelectAgent}
          />
        </div>
      )}

      <div className={searchBarClass}>
        <Search size={12} aria-hidden="true" className={searchIconClass} />
        <input
          type="text"
          placeholder="搜索会话"
          aria-label="搜索会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={searchInputClass}
        />
      </div>

      <div className="sidebar-content">
        {filtered(active).length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={24} strokeWidth={1.5} aria-hidden="true" className={emptyIconClass} />
            <div>{search ? "无匹配会话" : "暂无会话"}</div>
            {!search && <div className={emptyHintClass}>点击 + 创建新会话</div>}
          </div>
        ) : (
          filtered(active).map((session) => (
            <div
              key={session.id}
              className={`sidebar-item${session.id === activeSessionId ? " active" : ""}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelect(session.id); }}
            >
              <div className={sessionRowClass}>
                <div className={`sidebar-item-title ${sessionTitleClass}`.trim()}>{session.title}</div>
                <button
                  className={`icon-button ${archiveBtnClass}`.trim()}
                  onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
                  type="button"
                  aria-label={`归档会话 ${session.title}`}
                  title="归档会话"
                >
                  <Archive size={12} aria-hidden="true" />
                </button>
              </div>
              <div className="sidebar-item-meta">
                {(() => {
                  const agentId = session.agentId;
                  if (agentId === null) return null;
                  const name = resolveAgentName(agentId);
                  if (name === null) return null;
                  return (
                    <span className="sidebar-agent-badge">
                      <AgentAvatar agentId={agentId} name={name} size="sm" />
                      {name}
                    </span>
                  );
                })()}
                {session.messages.length} 条消息 · {session.toolMode}
              </div>
            </div>
          ))
        )}

        {archived.length > 0 && (
          <div className={archivedGroupClass}>
            <button
              type="button"
              onClick={() => setShowArchived(!showArchived)}
              aria-expanded={showArchived}
              className={archivedToggleClass}
            >
              {showArchived ? "▾" : "▸"} 已归档（{archived.length}）
            </button>
            {showArchived && filtered(archived).map((session) => (
              <div
                key={session.id}
                className={`sidebar-item ${archivedItemClass}`.trim()}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(session.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onSelect(session.id); }}
              >
                <div className={sessionRowClass}>
                  <div className={`sidebar-item-title ${sessionTitleClass}`.trim()}>{session.title}</div>
                  <button
                    className={`icon-button ${archiveBtnClass}`.trim()}
                    onClick={(e) => { e.stopPropagation(); onUnarchive(session.id); }}
                    type="button"
                    aria-label={`重开会话 ${session.title}`}
                    title="重开会话"
                  >
                    <ArchiveRestore size={12} aria-hidden="true" />
                  </button>
                </div>
                <div className="sidebar-item-meta">
                  {session.messages.length} 条消息 · 已归档
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
