/**
 * A4a lane 本地 Page Object（L6）：侧栏行内重命名与归档区（SESS-03 / SESS-04）。
 * 共享 pages/chat-po.ts、pages/onboarding-po.ts 保持只读；本文件只补 lane 覆盖面。
 * 定位手段：role + name 优先（渲染层暂无 oc- data-testid，与共享 PO 同一现状）。
 */
import { expect, type Page } from "@playwright/test";

function nameRegex(fragment: string): RegExp {
  return new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

export class LaneSidebarPO {
  constructor(private readonly page: Page) {}

  /** 会话行（role=button，可访问名含标题/时间/摘要） */
  threadRow(titleFragment: string) {
    return this.page.getByRole("button", { name: nameRegex(titleFragment) });
  }

  /** SESS-03：点行内铅笔进入编辑态 */
  async startRename(titleFragment: string): Promise<void> {
    await this.threadRow(titleFragment).getByRole("button", { name: "编辑标题" }).click();
  }

  /** 编辑态输入框（aria-label=编辑会话标题） */
  renameInput() {
    return this.page.getByRole("textbox", { name: "编辑会话标题" });
  }

  /** SESS-03：Enter 保存（onKeyDown save） */
  async confirmRename(newTitle: string): Promise<void> {
    await this.renameInput().fill(newTitle);
    await this.renameInput().press("Enter");
  }

  /** SESS-03：Esc 取消 */
  async cancelRename(): Promise<void> {
    await this.renameInput().press("Escape");
  }

  /** SESS-04：归档区开关（精确名「已归档」，避免匹配恢复后的活跃行标题） */
  archivedToggle() {
    return this.page.getByRole("button", { name: "已归档", exact: true });
  }

  /** SESS-04：归档区计数（archived-count span） */
  archivedCount() {
    return this.page.locator(".archived-count");
  }

  /** SESS-04：归档行容器（非 button role，仅展示 + 行内「恢复」按钮） */
  archivedRow(titleFragment: string) {
    return this.page.locator(".archived-row", { hasText: titleFragment });
  }

  /** SESS-04：归档行内的「恢复」按钮 */
  unarchiveButton(titleFragment: string) {
    return this.archivedRow(titleFragment).getByRole("button", { name: "恢复" });
  }
}
