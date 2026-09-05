import { Archive, BarChart3, ChevronDown, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Agent, Thread } from "../mock-data.js";
import "./Sidebar.css";

/**
 * T9 会话中心 IA：侧栏不再有全局"当前助理"概念（无卡片、无切换器）。
 * 会话行在助理数 ≥2 时用 badge 自标识所属助理（参考 openhanako SessionList AgentBadge）。
 */
interface SidebarProps {
  readonly threads: readonly Thread[];
  readonly archivedThreads: readonly Thread[];
  readonly activeThreadId: string;
  /** 助理 id → Agent 映射（会话行 badge 用） */
  readonly agentsById: ReadonlyMap<string, Agent>;
  /** 助理数 ≥2 时才显示 badge（单助理是噪音） */
  readonly showAgentBadge: boolean;
  readonly onThread: (id: string) => void;
  readonly onNewThread: () => void;
  readonly onUpdateThreadTitle: (sessionId: string, title: string) => void;
  readonly onUnarchiveThread: (sessionId: string) => void;
  readonly onCollapse: () => void;
  /** A8c：全局用量页入口（侧栏底部，与设置同排风格） */
  readonly onOpenUsage: () => void;
  readonly onOpenSettings: () => void;
}

interface SidebarRailProps {
  readonly onExpand: () => void;
  readonly onNewThread: () => void;
  /** A8c：收起态保持用量入口可达（与展开态侧栏底部入口一致） */
  readonly onOpenUsage: () => void;
  readonly onOpenSettings: () => void;
}

export function SidebarRail({ onExpand, onNewThread, onOpenUsage, onOpenSettings }: SidebarRailProps) {
  return (
    <aside className="sidebar-rail" aria-label="会话侧栏（已收起）">
      <button type="button" className="icon-btn" aria-label="展开侧栏" title="展开侧栏" onClick={onExpand}>
        <PanelLeftOpen size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="新建会话" title="新建会话" onClick={onNewThread}>
        <Plus size={16} />
      </button>
      <div className="rail-spacer" />
      <button type="button" className="icon-btn" aria-label="用量" title="用量" data-testid="oc-rail-usage" onClick={onOpenUsage}>
        <BarChart3 size={15} />
      </button>
      <button type="button" className="icon-btn" aria-label="设置" title="设置" onClick={onOpenSettings}>
        <Settings size={15} />
      </button>
    </aside>
  );
}

function formatArchivedTime(iso: string | undefined): string {
  if (iso === undefined) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

/** 会话行助理 badge：色点 + 名字（agentId 为 null 的历史会话不显示） */
function ThreadAgentBadge({ agent }: { readonly agent: Agent }) {
  return (
    <span className="thread-agent-badge">
      <i style={{ background: agent.color }} aria-hidden="true" />
      {agent.name}
    </span>
  );
}

function ThreadRow({
  thread,
  isActive,
  agentBadge,
  onClick,
  onUpdateTitle,
}: {
  readonly thread: Thread;
  readonly isActive: boolean;
  readonly agentBadge: Agent | null;
  readonly onClick: () => void;
  readonly onUpdateTitle: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(thread.title);
  }, [thread.title]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [editing]);

  function startEdit(event: React.MouseEvent) {
    event.stopPropagation();
    setDraftTitle(thread.title);
    setEditing(true);
  }

  function save() {
    const next = draftTitle.trim();
    if (next !== "" && next !== thread.title) {
      onUpdateTitle(next);
    }
    setEditing(false);
  }

  function cancel() {
    setDraftTitle(thread.title);
    setEditing(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <div className={`thread-row thread-row-editing${isActive ? " is-active" : ""}`}>
        <input
          ref={inputRef}
          type="text"
          className="thread-title-input"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
          onClick={(event) => event.stopPropagation()}
          aria-label="编辑会话标题"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`thread-row${isActive ? " is-active" : ""}`}
      onClick={onClick}
      onDoubleClick={startEdit}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <span className="thread-row-top">
        <strong>{thread.title}</strong>
        <span className="thread-row-actions">
          <time>{thread.time}</time>
          <button
            type="button"
            className="icon-btn thread-edit-btn"
            aria-label="编辑标题"
            title="编辑标题"
            onClick={startEdit}
          >
            <Pencil size={13} />
          </button>
        </span>
      </span>
      <small>
        {agentBadge !== null && <ThreadAgentBadge agent={agentBadge} />}
        <i className={`status-dot status-${thread.status}`} aria-hidden="true" />
        {thread.preview}
      </small>
    </div>
  );
}

function ThreadGroup({
  title,
  threads,
  activeThreadId,
  agentsById,
  showAgentBadge,
  onThread,
  onUpdateThreadTitle,
}: {
  readonly title: string;
  readonly threads: readonly Thread[];
  readonly activeThreadId: string;
  readonly agentsById: ReadonlyMap<string, Agent>;
  readonly showAgentBadge: boolean;
  readonly onThread: (id: string) => void;
  readonly onUpdateThreadTitle: (sessionId: string, title: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="thread-group">
      <header>{title}</header>
      <div className="thread-list">
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            agentBadge={
              showAgentBadge && thread.agentId !== null
                ? agentsById.get(thread.agentId) ?? null
                : null
            }
            onClick={() => onThread(thread.id)}
            onUpdateTitle={(title) => onUpdateThreadTitle(thread.id, title)}
          />
        ))}
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const {
    threads, archivedThreads, activeThreadId, agentsById, showAgentBadge,
    onThread, onNewThread, onUpdateThreadTitle, onUnarchiveThread, onCollapse, onOpenUsage, onOpenSettings,
  } = props;
  const [archivedOpen, setArchivedOpen] = useState(false);

  const activeThreads = threads.filter((thread) => thread.status === "active");
  const recentThreads = threads.filter((thread) => thread.status !== "active");

  return (
    <aside className="sidebar">
      <div className="sidebar-head sidebar-head-simple">
        <button type="button" className="btn btn-primary sidebar-new-thread" onClick={onNewThread}>
          <Plus size={15} />
          新建会话
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={onCollapse}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="sidebar-section">
        <header>
          <span>会话</span>
        </header>
        <ThreadGroup
          title="进行中"
          threads={activeThreads}
          activeThreadId={activeThreadId}
          agentsById={agentsById}
          showAgentBadge={showAgentBadge}
          onThread={onThread}
          onUpdateThreadTitle={onUpdateThreadTitle}
        />
        <ThreadGroup
          title="最近"
          threads={recentThreads}
          activeThreadId={activeThreadId}
          agentsById={agentsById}
          showAgentBadge={showAgentBadge}
          onThread={onThread}
          onUpdateThreadTitle={onUpdateThreadTitle}
        />
      </div>

      {archivedThreads.length > 0 && (
        <div className="sidebar-section archived-section">
          <header>
            <button
              type="button"
              className={`archived-toggle${archivedOpen ? " is-open" : ""}`}
              onClick={() => setArchivedOpen((v) => !v)}
              aria-expanded={archivedOpen}
            >
              <Archive size={13} />
              <span>已归档</span>
              <ChevronDown size={12} />
            </button>
            <span className="archived-count">{archivedThreads.length}</span>
          </header>
          {archivedOpen && (
            <div className="thread-list archived-list">
              {archivedThreads.map((thread) => {
                const agent = showAgentBadge && thread.agentId !== null
                  ? agentsById.get(thread.agentId)
                  : undefined;
                return (
                  <div key={thread.id} className="thread-row archived-row">
                    <span className="thread-row-top">
                      <strong>{thread.title}</strong>
                      <time>{formatArchivedTime(thread.archivedAt)}</time>
                    </span>
                    <span className="archived-actions">
                      <small>已归档{agent !== undefined ? ` · ${agent.name}` : ""}</small>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => onUnarchiveThread(thread.id)}
                      >
                        <RotateCcw size={11} />恢复
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-spacer" />

      <div className="sidebar-foot">
        <button type="button" className="plain-row" data-testid="oc-sidebar-usage" onClick={onOpenUsage}>
          <BarChart3 size={14} />
          <span><strong>用量</strong></span>
        </button>
        <button type="button" className="plain-row" onClick={onOpenSettings}>
          <Settings size={14} />
          <span><strong>设置</strong></span>
        </button>
      </div>
    </aside>
  );
}
