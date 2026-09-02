/**
 * A4c lane 本地 Page Object（L6）：设置 → 模型与 Provider 面板（ProvidersSettings.tsx）。
 * 只暴露用户动作与可见断言（desktop-test-conventions §三）。
 * lane 本地 fixture（agent-delegated 细节）；若其他 lane 需要复用，应经主 Agent
 * 收敛到共享层 desktop/tests/e2e/pages/，不得各自复制。
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type CredentialBadge = "已配置凭据" | "未配置凭据";

export interface ProviderFormInput {
  readonly providerId?: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly modelName?: string;
  readonly contextWindow?: string;
  readonly maxTokens?: string;
  readonly apiKey?: string;
}

export class ProvidersPO {
  constructor(private readonly page: Page) {}

  private dialog(): Locator {
    return this.page.getByRole("dialog", { name: "设置" });
  }

  /** Provider 卡片（li.pv-card；按名称或 Base URL 片段定位） */
  card(nameOrBaseUrl: string): Locator {
    return this.dialog().locator(".pv-card").filter({ hasText: nameOrBaseUrl });
  }

  async expectCardVisible(nameOrBaseUrl: string, badge: CredentialBadge): Promise<void> {
    const target = this.card(nameOrBaseUrl);
    await expect(target).toBeVisible();
    await expect(target).toContainText(badge);
  }

  async openAddForm(): Promise<void> {
    await this.dialog().getByRole("button", { name: "+ 添加 Provider" }).click();
    await expect(this.dialog().getByLabel("Provider ID")).toBeVisible();
  }

  /** 填表（只写传入字段；表单状态跨失败保存保留，可分步修正） */
  async fillForm(input: ProviderFormInput): Promise<void> {
    if (input.providerId !== undefined) await this.dialog().getByLabel("Provider ID").fill(input.providerId);
    if (input.name !== undefined) await this.dialog().getByLabel("名称").fill(input.name);
    if (input.baseUrl !== undefined) await this.dialog().getByLabel("Base URL").fill(input.baseUrl);
    if (input.modelId !== undefined) await this.dialog().getByLabel("模型 ID").fill(input.modelId);
    if (input.modelName !== undefined) await this.dialog().getByLabel("模型显示名").fill(input.modelName);
    if (input.contextWindow !== undefined) await this.dialog().getByLabel("上下文窗口").fill(input.contextWindow);
    if (input.maxTokens !== undefined) await this.dialog().getByLabel("最大输出").fill(input.maxTokens);
    if (input.apiKey !== undefined) await this.dialog().getByLabel("API Key").fill(input.apiKey);
  }

  async save(): Promise<void> {
    await this.dialog().getByRole("button", { name: "保存 Provider" }).click();
  }

  /** 打开某卡片的编辑表单（预填；API Key 不回显） */
  async startEdit(nameOrBaseUrl: string): Promise<void> {
    await this.card(nameOrBaseUrl).getByRole("button", { name: "编辑" }).click();
    await expect(this.dialog().getByLabel("API Key")).toBeVisible();
  }

  /** 编辑表单的 API Key 输入框应为空（凭据不回显红线） */
  async expectApiKeyFieldEmpty(): Promise<void> {
    await expect(this.dialog().getByLabel("API Key")).toHaveValue("");
  }

  /** 保存成功后表单整体收起 */
  async expectFormHidden(): Promise<void> {
    await expect(this.dialog().getByLabel("API Key")).toHaveCount(0);
  }

  /**
   * 表单级/字段级保存错误（两者都是 role=alert；同一时刻表单内至多一处：
   * 字段级错误在输入变化时清除，服务端错误只在保存失败时出现）。
   */
  saveError(): Locator {
    return this.dialog().locator("form.pv-form").getByRole("alert");
  }
}
