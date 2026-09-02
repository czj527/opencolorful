/**
 * A4e lane · L6 Page Object：Subagent Dock（列表页态 / 详情页态）。
 * 只暴露用户动作与可见断言（desktop-test-conventions §三）；选择器与
 * SubagentDock.tsx 的真实 DOM 类名/可访问名一一对应。
 */
import { expect, type Page } from "@playwright/test";

export class SubagentDockPO {
  constructor(private readonly page: Page) {}

  /** 顶栏工作台切换按钮（DockToggleButtons aria-label="Subagent"；首条消息后 chat-head 才渲染） */
  toggleButton() {
    return this.page.getByRole("button", { name: "Subagent", exact: true }).first();
  }

  async open(): Promise<void> {
    await this.toggleButton().click();
    await expect(this.page.locator("aside.dock")).toBeVisible();
  }

  async close(): Promise<void> {
    await this.page.getByRole("button", { name: "关闭工作台" }).click();
    await expect(this.page.locator("aside.dock")).toHaveCount(0);
  }

  dockPanel() {
    return this.page.locator("aside.dock");
  }

  /** 列表卡片（标题即 TaskBrief.title） */
  card(title: string) {
    return this.dockPanel().locator(".subagent-card", { hasText: title });
  }

  async openCard(title: string): Promise<void> {
    await expect(this.card(title)).toBeVisible({ timeout: 30_000 });
    await this.card(title).click();
  }

  async backToList(): Promise<void> {
    await this.dockPanel().getByRole("button", { name: "返回列表" }).click();
  }

  /** 详情页刷新（icon-btn aria-label="刷新"） */
  async refreshDetail(): Promise<void> {
    await this.dockPanel().getByRole("button", { name: "刷新" }).click();
  }

  detailTitle() {
    return this.dockPanel().locator(".subagent-title");
  }

  objective() {
    return this.dockPanel().locator(".subagent-objective");
  }

  /** Run 状态徽章（st-run：running/succeeded/...） */
  runBadges() {
    return this.dockPanel().locator(".st-run");
  }

  sectionHeading(text: string) {
    return this.dockPanel().locator("h3", { hasText: text });
  }

  messageRows() {
    return this.dockPanel().locator(".subagent-msg");
  }
}
