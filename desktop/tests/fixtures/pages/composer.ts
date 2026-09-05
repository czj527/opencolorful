import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface ComposerPO {
  textbox(): HTMLTextAreaElement;
  type(text: string): Promise<void>;
  /** Enter 直发（Composer 的真实键入路径） */
  pressEnter(): Promise<void>;
  send(): Promise<void>;
  /** 无可用模型时模型 chip 显示「未配置模型」并禁用（CHAT-04） */
  noModelChip(): HTMLElement | null;
}

/** 消息输入区：真实键入 + 发送 */
export function makeComposerPO(user: UserEvent): ComposerPO {
  const box = () => screen.getByRole("textbox", { name: /给 .+ 的消息/ }) as HTMLTextAreaElement;
  return {
    textbox: box,
    async type(text) {
      await user.type(box(), text);
    },
    async pressEnter() {
      await user.type(box(), "{Enter}");
    },
    async send() {
      await user.click(screen.getByRole("button", { name: "发送" }));
    },
    noModelChip() {
      return screen.queryByRole("button", { name: "未配置模型" });
    },
  };
}
