import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface SidebarPO {
  newThread(): Promise<void>;
  openSettings(): Promise<void>;
  collapse(): Promise<void>;
  expand(): Promise<void>;
  isCollapsed(): boolean;
  isExpanded(): boolean;
  /** 会话行（role=button，可访问名含标题/时间/摘要） */
  threadRow(titleFragment: string): HTMLElement | null;
  selectThread(titleFragment: string): Promise<void>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 会话侧栏：新建/折叠/设置入口与会话行选择 */
export function makeSidebarPO(user: UserEvent): SidebarPO {
  return {
    async newThread() {
      await user.click(screen.getByRole("button", { name: "新建会话" }));
    },
    async openSettings() {
      await user.click(screen.getByRole("button", { name: "设置" }));
    },
    async collapse() {
      await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    },
    async expand() {
      await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    },
    isCollapsed() {
      return screen.queryByRole("complementary", { name: "会话侧栏（已收起）" }) !== null;
    },
    isExpanded() {
      return !this.isCollapsed() && screen.queryByRole("button", { name: "新建会话" }) !== null;
    },
    threadRow(titleFragment) {
      return screen.queryByRole("button", { name: new RegExp(escapeRegExp(titleFragment)) });
    },
    async selectThread(titleFragment) {
      await user.click(screen.getByRole("button", { name: new RegExp(escapeRegExp(titleFragment)) }));
    },
  };
}
