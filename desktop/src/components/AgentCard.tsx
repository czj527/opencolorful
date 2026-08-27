import { ChevronDown, PanelLeftClose } from "lucide-react";

import type { Agent } from "../mock-data.js";
import "./AgentCard.css";

/** 助理身份证状态：仅由真实运行时驱动，未提供时不渲染状态行。 */
export interface AssistantStatus {
  readonly label: string;
  readonly tone: "ok" | "busy" | "offline";
}

interface AgentCardProps {
  readonly agent: Agent;
  readonly status?: AssistantStatus;
  readonly onOpenProfile?: () => void;
  readonly onToggleSwitch: () => void;
  readonly switchOpen: boolean;
  readonly onCollapse: () => void;
}

/** 侧栏顶部身份证卡：头像、名称、描述、可选状态，以及切换/收起入口。 */
export function AgentCard({
  agent,
  status,
  onOpenProfile,
  onToggleSwitch,
  switchOpen,
  onCollapse,
}: AgentCardProps) {
  return (
    <div className="agent-card">
      <div className="agent-card-tools">
        <button
          type="button"
          className={`icon-btn agent-card-switch${switchOpen ? " is-active" : ""}`}
          aria-label="切换助理"
          title="切换助理"
          aria-expanded={switchOpen}
          onClick={onToggleSwitch}
        >
          <ChevronDown size={14} />
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
      <button type="button" className="agent-card-body" onClick={onOpenProfile}>
        <span
          className="agent-card-avatar"
          style={{ background: agent.color }}
          aria-hidden="true"
        >
          {agent.initial}
        </span>
        <span className="agent-card-copy">
          <strong>{agent.name}</strong>
          <small>{agent.description}</small>
          {status !== undefined && (
            <span className={`agent-card-status is-${status.tone}`}>
              <i aria-hidden="true" />
              {status.label}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
