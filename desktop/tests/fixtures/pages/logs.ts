import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface LogsPagePO {
  /** 数据到达的稳定标记：活动事件表渲染 */
  ready(): Promise<HTMLElement>;
  switchTab(label: "活动" | "错误" | "安全审计"): Promise<void>;
  /** 健康 badge（仅在渲染时存在） */
  healthBadge(label: string): HTMLElement | null;
}

/** 日志页：三 tab + 健康 badge */
export function makeLogsPagePO(user: UserEvent): LogsPagePO {
  return {
    async ready() {
      return screen.findByText("session.prompt.accepted");
    },
    async switchTab(label) {
      await user.click(screen.getByRole("button", { name: label }));
    },
    healthBadge(label) {
      return screen.queryByText(label);
    },
  };
}
