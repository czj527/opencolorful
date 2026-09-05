/**
 * A4c lane 本地 Page Object（L6）：设置弹窗。
 * 只暴露用户动作与可见断言（desktop-test-conventions §三）。
 * lane 本地 fixture（agent-delegated 细节）；若其他 lane 需要复用，应经主 Agent
 * 收敛到共享层 desktop/tests/e2e/pages/，不得各自复制。
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type SettingsCategoryLabel = "外观" | "模型与 Provider" | "对话显示" | "关于";

export class SettingsPO {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole("dialog", { name: "设置" });
  }

  /** 侧栏「设置」行 → 弹窗出现 */
  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(this.dialog()).toBeVisible({ timeout: 15_000 });
  }

  /** 切类目并以类目标题出现为同步点 */
  async switchCategory(label: SettingsCategoryLabel): Promise<void> {
    await this.dialog().getByRole("button", { name: label }).click();
    await expect(this.dialog().getByRole("heading", { name: label })).toBeVisible();
  }

  async close(): Promise<void> {
    await this.dialog().getByRole("button", { name: "关闭设置" }).click();
    await expect(this.dialog()).toHaveCount(0);
  }

  /** 全局默认模型下拉（DefaultModelRow；option value = ModelRef JSON） */
  defaultModelSelect(): Locator {
    return this.dialog().getByLabel("全局默认模型");
  }

  async selectDefaultModel(optionLabel: string): Promise<void> {
    await this.defaultModelSelect().selectOption({ label: optionLabel });
  }

  defaultModelValue(): Promise<string> {
    return this.defaultModelSelect().inputValue();
  }
}
