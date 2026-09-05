/**
 * L6 Page Object：首启四步引导（OnboardingPage.tsx）。
 * 只暴露用户动作与可见断言，不暴露内部 state（desktop-test-conventions §三）。
 * 定位手段：role + name 优先（渲染层暂无 oc- data-testid，属已知缺口，后续补齐后收敛到 testid）。
 */
import { expect, type Page } from "@playwright/test";

export interface OnboardingInput {
  readonly name: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

export class OnboardingPO {
  constructor(private readonly page: Page) {}

  /** ONB-01 锚点：干净 home 首启自动进入四步引导第 1 步 */
  async expectStepAssistantVisible(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "给你的助理起个名字" }),
      "干净 home 首启应自动进入四步引导",
    ).toBeVisible({ timeout: 30_000 });
  }

  /** 逐步走完四步：名字 → Provider（自定义预设指向本地 stub）→ 工作目录留空 → 权限确认 */
  async completeAllSteps(input: OnboardingInput): Promise<void> {
    // 第 1 步：创建助理（名字；底色模板取默认选中项）
    await this.page.getByLabel("名字").fill(input.name);
    await this.page.getByRole("button", { name: "下一步" }).click();

    // 第 2 步：配置模型 —— 选择「自定义」预设，Base URL 指向本地 stub Provider
    await this.expectStepVisible("接入模型");
    await this.page.getByRole("radio", { name: /自定义/ }).click();
    await this.page.getByLabel("API Key").fill(input.apiKey);
    await this.page.getByText("高级设置（Base URL / 模型）").click();
    await this.page.getByLabel("Base URL").fill(input.baseUrl);
    await this.page.getByLabel("模型 ID").fill(input.modelId);
    await this.page.getByRole("button", { name: "下一步" }).click();

    // 第 3 步：工作目录 —— 刻意留空（SESS-01 cwd 兜底回归锚点：无 defaultCwd 场景）
    await this.expectStepVisible("选一个工作目录");
    await expect(this.page.getByText("暂不设置：助理仍可对话")).toBeVisible();
    await this.page.getByRole("button", { name: "下一步" }).click();

    // 第 4 步：权限说明 → 完成
    await this.expectStepVisible("它能做什么、不能做什么");
    await this.page.getByRole("button", { name: "完成，开始对话" }).click();

    // 完成后进入对话空态（引导消失）
    await this.expectHidden(30_000);
  }

  private async expectStepVisible(heading: string): Promise<void> {
    await expect(this.page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  }

  async expectHidden(timeout: number): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "给你的助理起个名字" }),
    ).toHaveCount(0, { timeout });
  }
}
