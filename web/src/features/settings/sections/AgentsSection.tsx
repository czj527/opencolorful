import { useEffect, useState } from "react";
import type { AgentView } from "../../../lib/types.js";
import { AgentAvatar } from "../../agents/AgentAvatar.js";
import { Button } from "../../../components/ui/index.js";
import styles from "./AgentsSection.module.css";

export interface AgentsSectionProps {
  readonly agents: readonly AgentView[];
  readonly highlightedAgentId?: string | null | undefined;
  readonly onNavigateNew: () => void;
  readonly onNavigateEdit: (id: string) => void;
  readonly onArchive: (id: string) => Promise<void>;
}

function CwdSummary(props: { cwd: string | null }): string {
  if (props.cwd === null) return "未设置";
  const max = 50;
  return props.cwd.length > max ? props.cwd.slice(0, max) + "…" : props.cwd;
}

export function AgentsSection(props: AgentsSectionProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(props.highlightedAgentId ?? null);

  // Clear highlight after animation
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // Sync external highlight
  useEffect(() => {
    if (props.highlightedAgentId) {
      setHighlightId(props.highlightedAgentId);
    }
  }, [props.highlightedAgentId]);

  const handleToggleMenu = (id: string) => {
    setMenuOpenId((prev) => (prev === id ? null : id));
  };

  const handleArchive = async (id: string) => {
    setMenuOpenId(null);
    await props.onArchive(id);
  };

  return (
    <>
      <div className={styles.toolbar}>
        <Button variant="primary" size="sm" onClick={props.onNavigateNew}>
          + 新建 Agent
        </Button>
      </div>

      {props.agents.length === 0 && (
        <p className={styles.emptyHint}>暂无 Agent，点击上方按钮创建第一个。</p>
      )}

      <ul className={styles.list}>
        {props.agents.map((agent) => {
          const isHighlight = highlightId === agent.identity.id;
          const cardClass = [styles.card, isHighlight ? styles.cardHighlight : ""]
            .filter(Boolean)
            .join(" ");
          const menuOpen = menuOpenId === agent.identity.id;

          return (
            <li
              key={agent.identity.id}
              className={cardClass}
              data-testid={`agent-card-${agent.identity.id}`}
            >
              <div
                className={styles.cardMain}
                onClick={() => props.onNavigateEdit(agent.identity.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onNavigateEdit(agent.identity.id);
                  }
                }}
              >
                <AgentAvatar agentId={agent.identity.id} name={agent.identity.name} size="md" />
                <div className={styles.info}>
                  <span className={styles.name}>{agent.identity.name}</span>
                  <span className={styles.meta}>
                    {agent.sessionCount} 会话
                    <span className={styles.dot}> · </span>
                    <span title={agent.settings.defaultCwd ?? undefined}>
                      {CwdSummary({ cwd: agent.settings.defaultCwd })}
                    </span>
                  </span>
                </div>
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.menuBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleMenu(agent.identity.id);
                  }}
                  aria-label="更多操作"
                  aria-expanded={menuOpen}
                >
                  ⋮
                </button>
                {menuOpen && (
                  <div className={styles.menu} role="menu">
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleArchive(agent.identity.id);
                      }}
                    >
                      归档 Agent
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
