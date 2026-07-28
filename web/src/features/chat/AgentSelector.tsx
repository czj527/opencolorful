import type { AgentView } from "../../lib/types.js";
import styles from "./AgentSelector.module.css";

export interface AgentSelectorProps {
  readonly agents: readonly AgentView[];
  readonly activeAgentId: string | null;
  readonly onSelect: (id: string | null) => void;
}

export function AgentSelector({ agents, activeAgentId, onSelect }: AgentSelectorProps) {
  return (
    <div className={styles.wrapper ?? ""} data-testid="agent-selector">
      <select
        value={activeAgentId ?? ""}
        onChange={(e) => {
          const val = e.target.value;
          onSelect(val === "" ? null : val);
        }}
        className={styles.select ?? ""}
        aria-label="选择 Agent"
      >
        <option value="">
          默认（无 Agent）
        </option>
        {agents.map((a) => (
          <option key={a.identity.id} value={a.identity.id}>
            {a.identity.name}
          </option>
        ))}
      </select>
    </div>
  );
}
