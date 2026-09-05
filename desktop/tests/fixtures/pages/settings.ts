import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface SettingsPO {
  dialog(): HTMLElement;
  switchCategory(label: "外观" | "模型与 Provider" | "对话显示" | "关于"): Promise<void>;
  categoryButton(label: string): HTMLElement | null;
  /** local-prefs 驱动的开关（role=switch） */
  toggle(label: string): HTMLElement;
  setTheme(label: "浅色" | "深色" | "跟随系统"): Promise<void>;
  close(): Promise<void>;
}

/** 设置弹窗（四类目） */
export function makeSettingsPO(user: UserEvent): SettingsPO {
  const dialog = () => screen.getByRole("dialog", { name: "设置" });
  const scoped = () => within(dialog());
  return {
    dialog,
    async switchCategory(label) {
      await user.click(scoped().getByRole("button", { name: label }));
    },
    categoryButton(label) {
      return scoped().queryByRole("button", { name: label });
    },
    toggle(label) {
      return scoped().getByRole("switch", { name: label });
    },
    async setTheme(label) {
      const group = scoped().getByRole("group", { name: "主题" });
      await user.click(within(group).getByRole("button", { name: label }));
    },
    async close() {
      await user.click(scoped().getByRole("button", { name: "关闭设置" }));
    },
  };
}
