import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * 用量页 Page Object（A8c）：只暴露用户动作与可见断言，不暴露内部 state。
 * 入口在侧栏底部（图标+用量），折叠态在侧栏 rail 上。
 */
export interface UsagePagePO {
  /** 从侧栏进入用量页（展开态入口） */
  openViaSidebar(): Promise<void>;
  /** 从收起态 rail 进入用量页 */
  openViaRail(): Promise<void>;
  /** 汇总卡渲染完成的稳定标记 */
  ready(): Promise<HTMLElement>;
  setDays(value: "7" | "30" | "90"): Promise<void>;
  setSource(value: "" | "main" | "subagent" | "utility"): Promise<void>;
  setRole(value: "" | "primary" | "secondary"): Promise<void>;
  /** 汇总卡（含总 token 与命中率文案） */
  totalCard(): HTMLElement | null;
  stat(key: "input" | "output" | "cache-read" | "cache-write" | "calls" | "turns" | "sessions"): HTMLElement | null;
  sourceRow(source: "main" | "subagent" | "utility"): HTMLElement | null;
  statusRow(status: "completed" | "failed" | "cancelled" | "timeout"): HTMLElement | null;
  modelRow(provider: string, model: string): HTMLElement | null;
  emptyState(): HTMLElement | null;
  errorAlert(): HTMLElement | null;
  retry(): Promise<void>;
}

export function makeUsagePagePO(user: UserEvent): UsagePagePO {
  return {
    async openViaSidebar() {
      await user.click(screen.getByRole("button", { name: "用量" }));
    },
    async openViaRail() {
      await user.click(screen.getByTestId("oc-rail-usage"));
    },
    async ready() {
      return screen.findByTestId("oc-usage-total-card");
    },
    async setDays(value) {
      await user.selectOptions(screen.getByTestId("oc-usage-days-filter"), value);
    },
    async setSource(value) {
      await user.selectOptions(screen.getByTestId("oc-usage-source-filter"), value);
    },
    async setRole(value) {
      await user.selectOptions(screen.getByTestId("oc-usage-role-filter"), value);
    },
    totalCard() {
      return screen.queryByTestId("oc-usage-total-card");
    },
    stat(key) {
      return screen.queryByTestId(`oc-usage-stat-${key}`);
    },
    sourceRow(source) {
      return screen.queryByTestId(`oc-usage-source-row-${source}`);
    },
    statusRow(status) {
      return screen.queryByTestId(`oc-usage-status-row-${status}`);
    },
    modelRow(provider, model) {
      return screen.queryByTestId(`oc-usage-model-row-${provider}-${model}`);
    },
    emptyState() {
      return screen.queryByTestId("oc-usage-empty");
    },
    errorAlert() {
      return screen.queryByTestId("oc-usage-error");
    },
    async retry() {
      await user.click(screen.getByTestId("oc-usage-retry"));
    },
  };
}
