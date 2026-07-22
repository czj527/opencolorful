import type { PlanItem as PlanItemData } from "./chat-state.js";
import { ListTodo } from "lucide-react";

interface PlanItemProps {
  readonly items: readonly PlanItemData[];
}

export function PlanList({ items }: PlanItemProps) {
  if (items.length === 0) return null;

  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-tertiary)",
        borderRadius: 6,
        borderLeft: "2px solid var(--accent)",
        fontSize: 13,
      }}
      data-testid="plan-list"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontWeight: 600 }}>
        <ListTodo size={14} aria-hidden="true" />
        计划
      </div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {items.map((item) => (
          <li key={item.id} style={{ marginBottom: 2 }}>{item.text}</li>
        ))}
      </ol>
    </div>
  );
}
