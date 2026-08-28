import type { Agent } from "../mock-data.js";
import type { AssistantStatus } from "./AgentIdCard.js";
import "./AgentChip.css";

interface AgentChipProps {
  readonly agent: Agent;
  readonly status?: AssistantStatus;
  readonly onOpenProfile: () => void;
}

/**
 * T9 会话头助理 chip：标识当前会话所属助理（thread.agentId 驱动），点击进档案页。
 * 新会话的助理选择发生在空态 chips（openhanako WelcomeScreen 模式），不在 chip 上。
 */
export function AgentChip({ agent, status, onOpenProfile }: AgentChipProps) {
  return (
    <button
      type="button"
      className="agent-chip"
      onClick={onOpenProfile}
      title={`查看 ${agent.name} 的档案`}
    >
      <span className="agent-dot" style={{ background: agent.color, width: 20, height: 20, fontSize: 11 }} aria-hidden="true">
        {agent.initial}
      </span>
      <span className="agent-chip-name">{agent.name}</span>
      {status !== undefined && (
        <i className={`agent-chip-status is-${status.tone}`} title={status.label} aria-label={status.label} />
      )}
    </button>
  );
}
