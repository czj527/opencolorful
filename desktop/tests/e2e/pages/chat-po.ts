/**
 * L6 Page Object：聊天页（Composer / ChatView / Sidebar 会话行）。
 * 只暴露用户动作与可见断言；流式状态经发送按钮的可访问名（发送 ↔ 停止生成）判别，
 * 该按钮 aria-label 由 App 的 streaming 布尔驱动，是真链流式状态的可见投影。
 */
import { expect, type Page } from "@playwright/test";

export class ChatPO {
  constructor(private readonly page: Page) {}

  composer(): ReturnType<Page["getByRole"]> {
    return this.page.getByRole("textbox", { name: /给 .+ 的消息/ });
  }

  async fill(text: string): Promise<void> {
    await expect(this.composer()).toBeVisible({ timeout: 15_000 });
    await this.composer().fill(text);
  }

  async send(): Promise<void> {
    await this.page.getByRole("button", { name: "发送", exact: true }).click();
  }

  /** CHAT-03 锚点：进入流式态（发送按钮切换为「停止生成」） */
  async expectStreaming(timeout = 20_000): Promise<void> {
    await expect(
      this.page.getByRole("button", { name: "停止生成", exact: true }),
    ).toBeVisible({ timeout });
  }

  /** 流式结束/中止完成：回到可输入态（ABORT-01「退出流式态，可继续输入」）。
   * 以 aria-label 切回「发送」且「停止生成」消失为准；发送键在草稿为空时
   * 本来就是禁用的（Composer disabled={!streaming && !canSend}），不能当流式信号。 */
  async expectIdle(timeout = 20_000): Promise<void> {
    const send = this.page.getByRole("button", { name: "发送", exact: true });
    await expect(send).toBeVisible({ timeout });
    await expect(this.page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
  }

  /** 消息文本可见（用户或助手；正文按追加式渲染，前缀即可命中） */
  async expectMessageVisible(text: string, timeout = 15_000): Promise<void> {
    await expect(this.page.getByText(text).first()).toBeVisible({ timeout });
  }

  /** ABORT-01：流式中点点击停止 */
  async stop(): Promise<void> {
    await this.page.getByRole("button", { name: "停止生成", exact: true }).click();
  }

  /** 侧栏会话行（草稿态文案「发送首条消息后才会出现在会话列表」随首发落库消失） */
  async expectDraftNoticeGone(): Promise<void> {
    await expect(this.page.getByText("发送首条消息后才会出现在会话列表")).toHaveCount(0);
  }

  async openSession(titleSubstring: string): Promise<void> {
    await this.page.getByRole("button", { name: new RegExp(titleSubstring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  }
}
