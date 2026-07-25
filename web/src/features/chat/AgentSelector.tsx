import type { AgentView } from "../../lib/types.js";

export interface AgentSelectorProps {
  readonly agents: readonly AgentView[];
  readonly activeAgentId: string | null;
  readonly onSelect: (id: string | null) => void;
}

export function AgentSelector({ agents, activeAgentId, onSelect }: AgentSelectorProps) {
  return (
    <div style={{ position: "relative" }} data-testid="agent-selector">
      <select
        value={activeAgentId ?? ""}
        onChange={(e) => {
          const val = e.target.value;
          onSelect(val === "" ? null : val);
        }}
        style={{
          appearance: "none",
          width: "100%",
          padding: "6px 10px",
          paddingRight: 28,
          borderRadius: 6,
          border: "1px solid var(--border-color)",
          background: "var(--bg-tertiary)",
          color: "var(--text-primary)",
          fontSize: 13,
          outline: "none",
          cursor: "pointer",
          transition: "border-color 0.15s",
        }}
        aria-label="选择 Agent"
      >
        <option value="">
          默认（无 Agent）
        </option>
        {agents.map((a) => (
          <option key={a.identity.id} value={a.identity.id}>
            {a.identity.name} [{a.identity.type}]
          </option>
        ))}
      </select>
    </div>
  );
}
