/**
 * L6 Page Object：分支工作台（分支切换器 / 线性 timeline 导航 / 消息级重生成 / Fork）。
 * 只暴露用户动作与可见断言；定位一律 data-testid（desktop-test-conventions §三）。
 * 409 busy 的可见面：切换器弹层内错误条（oc-branch-action-error + 停止）；
 * 消息级重生成的 409 在 ChatView 动作错误条（oc-branch-action-strip）。
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class BranchPO {
  constructor(private readonly page: Page) {}

  branchSwitcher(): Locator {
    return this.page.getByTestId("oc-branch-switcher");
  }

  menu(): Locator {
    return this.page.getByTestId("oc-branch-menu");
  }

  /** 幂等打开分支菜单（已开则直接返回） */
  async openMenu(): Promise<Locator> {
    const menu = this.menu();
    if (!(await menu.isVisible().catch(() => false))) {
      await this.branchSwitcher().click();
    }
    await expect(menu).toBeVisible();
    return menu;
  }

  async closeMenu(): Promise<void> {
    if (await this.menu().isVisible().catch(() => false)) {
      await this.branchSwitcher().click();
    }
    await expect(this.menu()).toHaveCount(0);
  }

  /** 当前分支条目数（触发按钮文案「分支 N」） */
  async expectBranchCount(count: number, timeout = 15_000): Promise<void> {
    await expect(this.branchSwitcher()).toContainText(`分支 ${count}`, { timeout });
  }

  /** 点击第 index 个（0 起）分支条目 */
  async switchToBranch(index: number): Promise<void> {
    const menu = await this.openMenu();
    await menu.locator('[data-testid^="oc-branch-item-"]').nth(index).click();
  }

  async expectBranchItemCount(count: number, timeout = 15_000): Promise<void> {
    const menu = await this.openMenu();
    await expect(menu.locator('[data-testid^="oc-branch-item-"]')).toHaveCount(count, { timeout });
    await this.closeMenu();
  }

  /** 当前分支的 timeline 导航节点（第 index 个） */
  timelineNode(index: number): Locator {
    return this.page.locator('[data-testid^="oc-timeline-node-"]').nth(index);
  }

  async expectTimelineNodeCount(count: number, timeout = 15_000): Promise<void> {
    await expect(this.page.locator('[data-testid^="oc-timeline-node-"]')).toHaveCount(count, { timeout });
  }

  /** 用户消息「编辑并重生成」：entryId 可用 testid 精确定位 */
  async editAndRegenerate(entryId: string, newText: string): Promise<void> {
    await this.page.getByTestId(`oc-message-edit-${entryId}`).click();
    const editor = this.page.getByTestId("oc-regenerate-editor");
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox").fill(newText);
    await this.page.getByTestId("oc-regenerate-confirm").click();
  }

  /** 助手消息「重试」 */
  async retryMessage(entryId: string): Promise<void> {
    await this.page.getByTestId(`oc-message-retry-${entryId}`).click();
  }

  async fork(): Promise<void> {
    const menu = await this.openMenu();
    await menu.getByTestId("oc-fork-button").click();
  }

  /* ---- 409 busy 分态 ---- */

  /** 切换器弹层内的 busy 错误条（switch/fork 触发的 409） */
  async expectBusyErrorInMenu(timeout = 20_000): Promise<void> {
    const error = this.menu().getByTestId("oc-branch-action-error");
    await expect(error).toContainText("会话正在运行，请先停止后再操作", { timeout });
    await expect(error.getByTestId("oc-branch-stop")).toBeVisible();
  }

  /** 弹层内错误条的「停止」动作（显式停止，不自动中止） */
  async stopFromMenu(): Promise<void> {
    await this.menu().getByTestId("oc-branch-stop").click();
  }

  /** ChatView 动作错误条（消息级重生成触发的 409） */
  actionStrip(): Locator {
    return this.page.getByTestId("oc-branch-action-strip");
  }

  async expectBusyStripVisible(timeout = 15_000): Promise<void> {
    await expect(this.actionStrip()).toContainText("会话正在运行，请先停止后再操作", { timeout });
    await expect(this.actionStrip().getByTestId("oc-branch-strip-stop")).toBeVisible();
  }
}
