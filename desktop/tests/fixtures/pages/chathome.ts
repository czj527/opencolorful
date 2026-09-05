import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface ChatHomePO {
  /** 草稿空态文案（SESS-02） */
  draftCopy(): HTMLElement;
  /** 「还没有可用的助理」空态（ONB-03） */
  noAgentHeading(): HTMLElement | null;
  startOnboarding(): Promise<void>;
  /** 身份证卡（AGENT-02） */
  agentCard(name: string): HTMLElement;
  openProfile(name: string): Promise<void>;
  /** 无可用模型时的配置入口（CHAT-04 空态侧） */
  noModelEntry(): HTMLElement | null;
  openAdvancedNewSession(): Promise<void>;
}

/** 对话页空态（新会话草稿态） */
export function makeChathomePO(user: UserEvent): ChatHomePO {
  return {
    draftCopy() {
      return screen.getByText("新会话为草稿：发送首条消息后才会出现在会话列表");
    },
    noAgentHeading() {
      return screen.queryByRole("heading", { name: "还没有可用的助理" });
    },
    async startOnboarding() {
      await user.click(screen.getByRole("button", { name: "开始引导" }));
    },
    agentCard(name) {
      return screen.getByRole("button", { name: `打开 ${name} 的档案页` });
    },
    async openProfile(name) {
      await user.click(screen.getByRole("button", { name: `打开 ${name} 的档案页` }));
    },
    noModelEntry() {
      return screen.queryByRole("button", { name: "还没有可用模型，去配置 Provider 与 API Key →" });
    },
    async openAdvancedNewSession() {
      await user.click(screen.getByRole("button", { name: "高级新建…" }));
    },
  };
}
