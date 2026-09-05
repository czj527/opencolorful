/**
 * 波次 B5b · L5 单测：SessionTodoCard 渲染（只读投影）。
 * - 四种状态字形/样式 + cancelled 删除线；第一个 in_progress 显示 activeForm
 * - done/total 计数（completed+cancelled 计入 done）；空列表不渲染
 * - 无任何写路径按钮（冻结：UI 只读）
 * 投影矩阵在 tests/unit/todo-projection.test.ts。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionTodoCard } from "./components/SessionTodoCard.js";
import type { SessionTodoItem } from "./mock-data.js";

const LIST: readonly SessionTodoItem[] = [
  { content: "梳理语义令牌分层", status: "completed", priority: "high" },
  { content: "落地 data-theme 覆盖方案", status: "in_progress", priority: "high", activeForm: "正在落地 data-theme 覆盖方案" },
  { content: "整理事件层收起策略", status: "pending", priority: "low" },
  { content: "废弃方案（已取消）", status: "cancelled", priority: "low" },
];

afterEach(cleanup);

describe("SessionTodoCard 渲染", () => {
  it("四状态字形与 data-status；第一个 in_progress 显示 activeForm；其余显示 content", () => {
    render(<SessionTodoCard todos={LIST} />);
    expect(screen.getByTestId("oc-todo-status-0").textContent).toBe("✓");
    expect(screen.getByTestId("oc-todo-status-1").textContent).toBe("→");
    expect(screen.getByTestId("oc-todo-status-2").textContent).toBe("○");
    expect(screen.getByTestId("oc-todo-status-3").textContent).toBe("✕");
    expect(screen.getByTestId("oc-todo-item-1").getAttribute("data-status")).toBe("in_progress");
    expect(screen.getByTestId("oc-todo-item-1").textContent).toContain("正在落地 data-theme 覆盖方案");
    expect(screen.getByTestId("oc-todo-item-0").textContent).toContain("梳理语义令牌分层");
  });

  it("done/total 计数把 completed+cancelled 计入 done", () => {
    render(<SessionTodoCard todos={LIST} />);
    expect(screen.getByTestId("oc-todo-counter").textContent).toBe("2/4");
  });

  it("空列表不渲染卡片", () => {
    const { container } = render(<SessionTodoCard todos={[]} />);
    expect(container.querySelector("[data-testid='oc-session-todo-card']")).toBeNull();
  });

  it("严格只读：不渲染任何按钮", () => {
    render(<SessionTodoCard todos={LIST} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
