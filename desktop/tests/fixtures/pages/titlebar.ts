import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface TitlebarPO {
  goto(page: "对话" | "记忆" | "日志"): Promise<void>;
  toggleTheme(): Promise<void>;
  themeToggleAriaLabel(): string;
}

/** 顶栏（常驻组件）：页面路由与主题快捷切换 */
export function makeTitlebarPO(user: UserEvent): TitlebarPO {
  const themeToggle = () => screen.getByRole("button", { name: /切换为(浅色|深色)主题/ });
  return {
    async goto(page) {
      await user.click(screen.getByRole("button", { name: page }));
    },
    async toggleTheme() {
      await user.click(themeToggle());
    },
    themeToggleAriaLabel() {
      return themeToggle().getAttribute("aria-label") ?? "";
    },
  };
}
