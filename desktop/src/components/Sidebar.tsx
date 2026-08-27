import { Archive, CalendarClock, ChevronDown, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentCard, type AssistantStatus } from "./AgentCard.js";
import type { Agent, Thread } from "../mock-data.js";
import "./Sidebar.css";

interface SidebarProps {
  readonly agents: readonly Agent[];
  readonly activeAgent: Agent | undefined;
  readonly onAgent: (id: string) => void;
  readonly threads: readonly Thread[];
  readonly archivedThreads: readonly Thread[];
  readonly activeThreadId: string;
  readonly onThread: (id: string) => void;
  readonly onNewThread: () => void;
  readonly onUpdateThreadTitle: (sessionId: string, title: string) => void;
  readonly onUnarchiveThread: (sessionId: string) => void;
  readonly onCollapse: () => void;
  readonly onOpenSettings: () => void;
  /** T4 身份证卡入口：打开助理档案页。T0 先行声明以固定车道接口（T4 消费）。 */
  readonly onOpenAssistantProfile?: () => void;
  /** T4 真实运行时状态；未提供时身份证卡不渲染状态行。 */
  readonly assistantStatus?: AssistantStatus;
}

interface SidebarRailProps {
  readonly agents: readonly Agent[];
  readonly activeAgent: Agent | undefined;
  readonly onAgent: (id: string) => void;
  readonly onExpand: () => void;
  readonly onNewThread: () => void;
  readonly onOpenSettings: () => void;
}

function AgentDot({ agent, size = 20 }: { readonly agent: Agent; readonly size?: number }) {
  return (
    <span
      className="agent-dot"
      style={{ width: size, height: size, background: agent.color, fontSize: size * 0.55 }}
      aria-hidden="true"
    >
      {agent.initial}
    </span>
  );
}

export function SidebarRail({ agents, activeAgent, onAgent, onExpand, onNewThread, onOpenSettings }: SidebarRailProps) {
  return (
    <aside className="sidebar-rail" aria-label="会话侧栏（已收起）">
      <button type="button" className="icon-btn" aria-label="展开侧栏" title="展开侧栏" onClick={onExpand}>
        <PanelLeftOpen size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="新建会话" title="新建会话" onClick={onNewThread}>
        <Plus size={16} />
      </button>
      <div className="rail-agents" role="group" aria-label="切换 Agent">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`rail-agent${agent.id === activeAgent?.id ? " is-active" : ""}`}
            aria-label={`切换到 ${agent.name}`}
            title={agent.name}
            onClick={() => onAgent(agent.id)}
          >
            <AgentDot agent={agent} size={22} />
          </button>
        ))}
      </div>
      <div className="rail-spacer" />
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

function ThreadRow({
  thread,
  isActive,
  onClick,
  onUpdateTitle,
}: {
  readonly thread: Thread;
  readonly isActive: boolean;
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
    <button
      type="button"
      className={`thread-row${isActive ? " is-active" : ""}`}
      onClick={onClick}
      onDoubleClick={startEdit}
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
      <small><i className={`status-dot status-${thread.status}`} aria-hidden="true" />{thread.preview}</small>
    </button>
  );
}

function ThreadGroup({
  title,
  threads,
  activeThreadId,
  onThread,
  onUpdateThreadTitle,
}: {
  readonly title: string;
  readonly threads: readonly Thread[];
  readonly activeThreadId: string;
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
    agents, activeAgent, onAgent, threads, archivedThreads, activeThreadId,
    onThread, onNewThread, onUpdateThreadTitle, onUnarchiveThread, onCollapse, onOpenSettings,
    onOpenAssistantProfile, assistantStatus,
  } = props;
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const activeThreads = threads.filter((thread) => thread.status === "active");
  const recentThreads = threads.filter((thread) => thread.status !== "active");

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {activeAgent === undefined ? (
          <div className="agent-card is-empty">
            <div className="agent-card-tools">
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
            <div className="agent-card-body">
              <span className="agent-card-avatar" style={{ background: "var(--text-3)" }} aria-hidden="true">?</span>
              <span className="agent-card-copy">
                <strong>无 Agent</strong>
                <small>完成首次引导后出现在这里</small>
              </span>
            </div>
          </div>
        ) : (
          <>
            <AgentCard
              agent={activeAgent}
              status={assistantStatus}
              onOpenProfile={onOpenAssistantProfile}
              onToggleSwitch={() => setAgentMenuOpen((v) => !v)}
              switchOpen={agentMenuOpen}
              onCollapse={onCollapse}
            />
            {agentMenuOpen && (
              <>
                <div className="menu-backdrop" onMouseDown={() => setAgentMenuOpen(false)} />
                <div className="agent-menu" role="menu">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className={agent.id === activeAgent.id ? "is-active" : ""}
                      onClick={() => { onAgent(agent.id); setAgentMenuOpen(false); }}
                    >
                      <AgentDot agent={agent} size={18} />
                      <span><strong>{agent.name}</strong><small>{agent.description}</small></span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="sidebar-section">
        <header>
          <span>会话</span>
          <button type="button" className="icon-btn" aria-label="新建会话" title="新建会话" onClick={onNewThread}>
            <Plus size={16} />
          </button>
        </header>
        <ThreadGroup
          title="进行中"
          threads={activeThreads}
          activeThreadId={activeThreadId}
          onThread={onThread}
          onUpdateThreadTitle={onUpdateThreadTitle}
        />
        <ThreadGroup
          title="最近"
          threads={recentThreads}
          activeThreadId={activeThreadId}
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
              {archivedThreads.map((thread) => (
                <div key={thread.id} className="thread-row archived-row">
                  <span className="thread-row-top">
                    <strong>{thread.title}</strong>
                    <time>{formatArchivedTime(thread.archivedAt)}</time>
                  </span>
                  <span className="archived-actions">
                    <small>已归档</small>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => onUnarchiveThread(thread.id)}
                    >
                      <RotateCcw size={11} />恢复
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-spacer" />

      <div className="sidebar-section">
        <header><span>定时任务</span></header>
        <button type="button" className="plain-row">
          <CalendarClock size={14} />
          <span><strong>每周记忆整理</strong><small>周日 21:00 · 空闲窗口</small></span>
        </button>
      </div>

      <div className="sidebar-foot">
        <button type="button" className="plain-row" onClick={onOpenSettings}>
          <Settings size={14} />
          <span><strong>设置</strong></span>
        </button>
      </div>
    </aside>
  );
}
