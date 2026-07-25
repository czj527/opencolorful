import type { PlanItem as PlanItemData } from "./chat-state.js";
import { ListTodo } from "lucide-react";
import styles from "./PlanItem.module.css";

interface PlanItemProps {
  readonly items: readonly PlanItemData[];
}

export function PlanList({ items }: PlanItemProps) {
  if (items.length === 0) return null;

  return (
    <div className={styles.planList ?? ""} data-testid="plan-list">
      <div className={styles.header ?? ""}>
        <ListTodo size={14} aria-hidden="true" />
        计划
      </div>
      <ol className={styles.list ?? ""}>
        {items.map((item) => (
          <li key={item.id} className={styles.item ?? ""}>{item.text}</li>
        ))}
      </ol>
    </div>
  );
}
