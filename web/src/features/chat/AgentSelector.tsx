import { Bot } from "lucide-react";
import type { AgentView } from "../../lib/types.js";

export interface AgentSelectorProps {
  readonly agents: readonly AgentView[];
  readonly activeAgentId: string | null;
  readonly onSelect: (id: string | null) => void;
}

const TYPE_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  assistant: { bg: "rgba(74,158,255,0.15)", fg: "var(--accent)" },
  coding: { bg: "rgba(74,255,120,0.12)", fg: "var(--success)" },
  work: { bg: "rgba(255,166,74,0.15)", fg: "var(--warning)" },
};

function AgentTypeBadge({ type }: { readonly type: string }) {
  const colors = TYPE_BADGE_COLORS[type] ?? { bg: "var(--bg-tertiary)", fg: "var(--text-secondary)" };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 8,
        background: colors.bg,
        color: colors.fg,
        textTransform: "uppercase",
        letterSpacing: "0.3px",
      }}
    >
      {type}
    </span>
  );
}

export function AgentSelector({ agents, activeAgentId, onSelect }: AgentSelectorProps) {
  const activeAgent = agents.find((a) => a.identity.id === activeAgentId) ?? null;

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

      {/* Selected agent display */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          padding: "6px 10px",
          background: "var(--bg-tertiary)",
          borderRadius: 6,
          border: "1px solid var(--border-color)",
          fontSize: 13,
          color: "var(--text-primary)",
        }}
      >
        {activeAgent ? (
          <>
            <Bot size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span style={{ fontWeight: 500 }}>{activeAgent.identity.name}</span>
            <AgentTypeBadge type={activeAgent.identity.type} />
            <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: "auto" }}>
              {activeAgent.sessionCount} 会话
            </span>
          </>
        ) : (
          <>
            <Bot size={16} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
            <span style={{ color: "var(--text-secondary)" }}>默认（无 Agent）</span>
          </>
        )}
      </div>
    </div>
  );
}
