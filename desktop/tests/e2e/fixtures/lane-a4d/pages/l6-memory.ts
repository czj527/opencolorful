/**
 * A4d lane 本地 Page Object：记忆页（L6 真链）。
 *
 * 锚点与 MemoryPage.tsx 一致：顶栏页签「记忆」、页头「X 的只读记忆视图」、
 * 后台整理 stat 卡（stat-value = maintenanceLabel(status, phase)，空闲时「空闲」）、
 * 「查看报告」按钮（status ∈ completed|deferred|failed 且 runId 存在时出现）、
 * 报告 details 块（summary「最近运行报告（脱敏）」+ pre 报告全文）。
 */
import type { Locator, Page } from "@playwright/test";

export class LaneMemoryPO {
  constructor(private readonly page: Page) {}

  /** 顶栏页签进入记忆页（限定 .page-tabs，避免匹配页面内其他含「记忆」的按钮） */
  open(): Promise<void> {
    return this.page.locator(".page-tabs").getByRole("button", { name: "记忆" }).click();
  }

  /** 页头锚点：「X 的只读记忆视图」 */
  heading(agentName: string): Locator {
    return this.page.getByText(`${agentName} 的只读记忆视图`);
  }

  /** 后台整理 stat 卡（strong 标签限定，与 RecallEpisode/Pending batch 卡区分） */
  maintenanceCard(): Locator {
    return this.page.locator(".stat-card", { has: this.page.getByText("后台整理", { exact: true }) });
  }

  /** 维护状态值（maintenanceLabel 渲染处） */
  maintenanceValue(): Locator {
    return this.maintenanceCard().locator(".stat-value");
  }

  reportButton(): Locator {
    return this.page.getByRole("button", { name: "查看报告" });
  }

  /** 报告 details 块（与四段编译制品的 details.compiled-block 以 summary 文本区分） */
  reportBlock(): Locator {
    return this.page.locator("details.compiled-block", { has: this.page.getByText("最近运行报告（脱敏）") });
  }
}
