/**
 * A4a lane 本地 Page Object（L6）：助理档案页（AGENT-03/04/05）。
 * 只暴露用户动作与可见断言；表单字段以段内 label 文本定位（页面暂无 oc- data-testid）。
 */
import { expect, type Page } from "@playwright/test";

function scopedField(page: Page, sectionHeading: string, labelText: string) {
  const section = page.locator(".page-section", { has: page.getByRole("heading", { name: sectionHeading }) });
  return section.locator("label", { hasText: labelText }).locator("input, textarea");
}

export class LaneProfilePO {
  constructor(private readonly page: Page) {}

  /** 档案页就绪锚点：标题 + 身份证卡段落 */
  async expectReady(agentName: string): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "助理档案" })).toBeVisible({ timeout: 15_000 });
    await expect(
      this.page.getByText(`${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 的身份证、人设与记忆管理。`, { exact: false }),
    ).toBeVisible();
  }

  /** 身份证卡区（profile-id-card） */
  idCard() {
    return this.page.locator(".profile-id-card");
  }

  /** AGENT-03：基础信息（名称/描述）保存 */
  async renameAndDescribe(name: string, description: string): Promise<void> {
    const nameInput = scopedField(this.page, "基础信息", "名称");
    await nameInput.fill(name);
    const descriptionInput = scopedField(this.page, "基础信息", "描述");
    await descriptionInput.fill(description);
    await this.page
      .locator(".page-section", { has: this.page.getByRole("heading", { name: "基础信息" }) })
      .getByRole("button", { name: "保存", exact: true })
      .click();
  }

  /** AGENT-04：人设（回复风格/人格标签）保存 */
  async savePersona(replyStyle: string, personality: string): Promise<void> {
    const styleInput = scopedField(this.page, "人设", "回复风格");
    await styleInput.fill(replyStyle);
    const tagsInput = scopedField(this.page, "人设", "人格标签");
    await tagsInput.fill(personality);
    await this.page
      .locator(".page-section", { has: this.page.getByRole("heading", { name: "人设" }) })
      .getByRole("button", { name: "保存人设" })
      .click();
  }

  /** 人设字段的当前值（重进/重启后读取） */
  personaFieldValue(labelText: string) {
    return scopedField(this.page, "人设", labelText);
  }

  /** AGENT-05：记忆设置开关（启用记忆整理 / 后台复盘）。
   * 开关按钮本身无文本（仅 <i/>），经所在设置行（含 strong 标签文本）限定。 */
  memoryToggle(label: "启用记忆整理" | "后台复盘") {
    return this.page.locator(".profile-setting-row", { hasText: label }).getByRole("button");
  }

  /** AGENT-05：每日整理时间（type=time） */
  memoryDailyTime() {
    return scopedField(this.page, "记忆设置", "每日整理时间");
  }

  /** AGENT-05：最小空闲分钟数（type=number） */
  memoryMinIdle() {
    return scopedField(this.page, "记忆设置", "最小空闲分钟数");
  }

  /** 身份证卡上的当前名称（loadAll 后的可见刷新） */
  async expectIdCardName(name: string): Promise<void> {
    await expect(this.idCard().locator("strong")).toHaveText(name);
  }
}
