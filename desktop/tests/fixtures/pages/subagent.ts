import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface SubagentDockPO {
  /** 列表加载完成标记 */
  ready(): Promise<HTMLElement>;
  card(titleFragment: string): HTMLElement | null;
  openCard(titleFragment: string): Promise<void>;
  backToList(): Promise<void>;
  sectionHeading(pattern: RegExp): HTMLElement;
}

/** Subagent 工作台（Dock 侧栏）：列表 → 详情 → 返回 */
export function makeSubagentDockPO(user: UserEvent): SubagentDockPO {
  const dock = () => screen.getByRole("complementary", { name: "工作台" });
  return {
    async ready() {
      return screen.findByText("前端参考调研");
    },
    card(titleFragment) {
      return within(dock()).queryByRole("button", { name: new RegExp(titleFragment) });
    },
    async openCard(titleFragment) {
      await user.click(within(dock()).getByRole("button", { name: new RegExp(titleFragment) }));
    },
    async backToList() {
      await user.click(within(dock()).getByRole("button", { name: /返回列表/ }));
    },
    sectionHeading(pattern) {
      return within(dock()).getByRole("heading", { name: pattern });
    },
  };
}
