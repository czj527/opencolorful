import type { SessionTodoItem, TodoStatus } from "../mock-data.js";
import "./SessionTodoCard.css";

/** 状态 → 字符标记（只读投影；无任何写路径按钮） */
function statusGlyph(status: TodoStatus): string {
  switch (status) {
    case "pending": return "○";
    case "in_progress": return "→";
    case "completed": return "✓";
    case "cancelled": return "✕";
  }
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  cancelled: "已取消",
};

/**
 * 波次 B5b：durable session todo 只读卡。
 * - 列表来自 SessionView.todos（打开/重启恢复）与 todo.updated 事件（整表替换）；
 * - 第一个 in_progress 显示 activeForm（进行时短语），其余显示 content；
 * - 空列表 → 不渲染（调用方保证）；
 * - 严格只读：无任何按钮。
 */
export function SessionTodoCard({ todos }: { readonly todos: readonly SessionTodoItem[] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((item) => item.status === "completed" || item.status === "cancelled").length;
  const activeForm = todos.find((item) => item.status === "in_progress")?.activeForm;
  return (
    <section className="session-todo-card" data-testid="oc-session-todo-card" aria-label="会话待办">
      <header className="session-todo-head">
        <span className="session-todo-title">会话待办</span>
        <span className="session-todo-counter" data-testid="oc-todo-counter">{done}/{todos.length}</span>
      </header>
      <ul className="session-todo-list">
        {todos.map((item, index) => (
          <li
            key={`${index}-${item.content}`}
            className={`session-todo-item session-todo-${item.status}`}
            data-testid={`oc-todo-item-${index}`}
            data-status={item.status}
          >
            <span className="session-todo-glyph" data-testid={`oc-todo-status-${index}`} title={STATUS_LABEL[item.status]}>
              {statusGlyph(item.status)}
            </span>
            <span className="session-todo-text">
              {item.status === "in_progress" && item.activeForm !== undefined ? item.activeForm : item.content}
            </span>
          </li>
        ))}
      </ul>
      {activeForm !== undefined && <p className="session-todo-active-hint">当前进行：{activeForm}</p>}
    </section>
  );
}
