/**
 * L5 · A8c（Desktop 全局模型用量页）Mock 渲染层回归：
 * - USAGE-02 Desktop 入口：侧栏「用量」进入，汇总卡与分组数字正确（mock 确定性聚合）；
 * - 时间范围/来源/角色切换触发重新拉取并改变展示（过滤参数真实下发）；
 * - 空态引导；加载失败中文错误 + 重试恢复。
 * 生产 MockDataSource fixture（daysAgo 跨 7/30/90 窗口）；注入态经 overrideSource。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource, UsageSummaryFilterView, UsageSummaryView } from "./data/source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeUsagePagePO } from "../tests/fixtures/pages/usage-page.js";

/**
 * 与 settings.mock.test.tsx 相同的注入通道：覆写 createDataSource 以注入
 * overrideSource 包装的生产 Mock（injected.current = null 时完全走原路径）。
 */
const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

/*
 * mock fixture 期望值（12 条确定性记录，daysAgo ∈ {0,1,2,3,12,45}）：
 * - days=30（默认）：11 条（排除 daysAgo=45），calls 11 / turns 6 / sessions 3
 * - days=7：10 条（再排除 daysAgo=12）；days=90：12 条（+s-main-4 会话）
 */
const EXPECT = {
  d30: { calls: 11, turns: 6, sessions: 3, total: "55,330", input: "29,850", output: "12,100", cacheRead: "11,480", cacheWrite: "1,900" },
  d7: { calls: 10, total: "54,350" },
  d90: { calls: 12, turns: 7, sessions: 4, total: "63,630" },
  source: { main: "31,800", subagent: "21,400", utility: "2,130" },
  status: { completed: "47,930", failed: "2,300", cancelled: "1,200", timeout: "3,900" },
  model: { deepseek: "34,900", moonshot: "20,430" },
};

function assertNoCost(): void {
  // 本波次不做 cost：页面任何可见文本不出现金额/费用字样（中英文）
  const text = (document.body.textContent ?? "").toLowerCase();
  expect(text).not.toContain("cost");
  expect(text).not.toContain("金额");
  expect(text).not.toContain("费用");
}

it("USAGE-02: 侧栏入口进入用量页——汇总卡与按来源/状态/模型分组数字正确", async () => {
  const app = await renderApp();
  const po = makeUsagePagePO(app.user);
  try {
    await po.openViaSidebar();
    const totalCard = await po.ready();

    // 汇总卡：总 token（toLocaleString 分组）+ 命中率文案 + 时间范围标注
    expect(totalCard?.textContent ?? "").toContain(EXPECT.d30.total);
    expect(totalCard?.textContent ?? "").toContain("缓存命中率");
    expect(totalCard?.textContent ?? "").toContain("近 30 天");

    // 统计格：输入/输出/缓存读/缓存写/调用次数/主对话轮次/会话数
    expect(po.stat("input")?.textContent).toContain(EXPECT.d30.input);
    expect(po.stat("output")?.textContent).toContain(EXPECT.d30.output);
    expect(po.stat("cache-read")?.textContent).toContain(EXPECT.d30.cacheRead);
    expect(po.stat("cache-write")?.textContent).toContain(EXPECT.d30.cacheWrite);
    expect(po.stat("calls")?.textContent).toContain(String(EXPECT.d30.calls));
    expect(po.stat("turns")?.textContent).toContain(String(EXPECT.d30.turns));
    expect(po.stat("sessions")?.textContent).toContain(String(EXPECT.d30.sessions));

    // 按来源：三行（主对话/子代理/后台任务）+ 合计
    expect(po.sourceRow("main")).not.toBeNull();
    expect(po.sourceRow("subagent")).not.toBeNull();
    expect(po.sourceRow("utility")).not.toBeNull();
    expect(within(po.sourceRow("main")!).getByText("主对话")).toBeTruthy();
    expect(within(po.sourceRow("main")!).getByText(EXPECT.source.main)).toBeTruthy();
    expect(within(po.sourceRow("subagent")!).getByText("子代理")).toBeTruthy();
    expect(within(po.sourceRow("subagent")!).getByText(EXPECT.source.subagent)).toBeTruthy();
    expect(within(po.sourceRow("utility")!).getByText("后台任务")).toBeTruthy();
    expect(within(po.sourceRow("utility")!).getByText(EXPECT.source.utility)).toBeTruthy();

    // 按状态：completed 突出渲染，failed/cancelled/timeout 可见
    expect(within(po.statusRow("completed")!).getByText("已完成")).toBeTruthy();
    expect(within(po.statusRow("completed")!).getByText(EXPECT.status.completed)).toBeTruthy();
    expect(within(po.statusRow("failed")!).getByText("失败")).toBeTruthy();
    expect(within(po.statusRow("failed")!).getByText(EXPECT.status.failed)).toBeTruthy();
    expect(within(po.statusRow("cancelled")!).getByText("已取消")).toBeTruthy();
    expect(within(po.statusRow("timeout")!).getByText("超时")).toBeTruthy();

    // 按模型：两个模型桶按 token 降序
    expect(within(po.modelRow("deepseek-local", "deepseek-v3.2")!).getByText(EXPECT.model.deepseek)).toBeTruthy();
    expect(within(po.modelRow("moonshot", "kimi-k3")!).getByText(EXPECT.model.moonshot)).toBeTruthy();

    // 按日期：daysAgo ∈ {0,1,2,3,12} → 5 个日期桶
    expect(document.querySelectorAll('[data-testid^="oc-usage-day-row-"]').length).toBe(5);
    assertNoCost();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("USAGE-02: 时间范围/来源/角色切换触发重新拉取并改变展示（过滤参数真实下发）", async () => {
  const calls: UsageSummaryFilterView[] = [];
  const base = new MockDataSource();
  injected.current = overrideSource(base, {
    getUsageSummary: (filter?: UsageSummaryFilterView) => {
      calls.push(filter ?? {});
      return base.getUsageSummary(filter);
    },
  });
  const app = await renderApp();
  const po = makeUsagePagePO(app.user);
  try {
    await po.openViaSidebar();
    await po.ready();
    expect(calls[0]).toEqual({ days: 30 });

    // 时间范围 30 → 7：排除 daysAgo=12 的 utility 记录（calls 11→10）
    await po.setDays("7");
    await waitFor(() => expect(calls[1]).toEqual({ days: 7 }));
    await waitFor(() => expect(po.stat("calls")?.textContent).toContain(String(EXPECT.d7.calls)));
    expect(po.totalCard()?.textContent ?? "").toContain(EXPECT.d7.total);

    // 时间范围 7 → 90：纳入 daysAgo=45 的 main 记录（calls 12 / turns 7 / sessions 4）
    await po.setDays("90");
    await waitFor(() => expect(calls[2]).toEqual({ days: 90 }));
    await waitFor(() => expect(po.stat("calls")?.textContent).toContain(String(EXPECT.d90.calls)));
    expect(po.stat("turns")?.textContent).toContain(String(EXPECT.d90.turns));
    expect(po.stat("sessions")?.textContent).toContain(String(EXPECT.d90.sessions));
    expect(po.totalCard()?.textContent ?? "").toContain(EXPECT.d90.total);
    expect(po.totalCard()?.textContent ?? "").toContain("近 90 天");

    // 来源过滤：main → subagent/utility 行消失，calls = main 记录数
    await po.setDays("30");
    await po.setSource("main");
    await waitFor(() => expect(calls.at(-1)).toEqual({ days: 30, source: "main" }));
    await waitFor(() => {
      expect(po.sourceRow("subagent")).toBeNull();
      expect(po.sourceRow("utility")).toBeNull();
      expect(po.sourceRow("main")).not.toBeNull();
    });
    expect(po.stat("calls")?.textContent).toContain("6");

    // 角色过滤叠加：main + primary → calls = 4，total 28,800
    await po.setRole("primary");
    await waitFor(() => expect(calls.at(-1)).toEqual({ days: 30, source: "main", role: "primary" }));
    await waitFor(() => expect(po.stat("calls")?.textContent).toContain("4"));
    expect(po.totalCard()?.textContent ?? "").toContain("28,800");
    assertNoCost();
  } finally {
    injected.current = null;
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("USAGE-02: 空态——calls=0 的合法响应展示引导文案，不渲染汇总卡", async () => {
  const base = new MockDataSource();
  injected.current = overrideSource(base, {
    getUsageSummary: (filter?: UsageSummaryFilterView) =>
      Promise.resolve(emptySummary(filter?.days ?? 30)),
  });
  const app = await renderApp();
  const po = makeUsagePagePO(app.user);
  try {
    await po.openViaSidebar();
    expect(await po.emptyState()).not.toBeNull();
    expect(screen.getByText("暂无模型用量记录")).toBeTruthy();
    expect(po.totalCard()).toBeNull();
    expect(po.stat("calls")).toBeNull();
    expect(po.sourceRow("main")).toBeNull();
    assertNoCost();
  } finally {
    injected.current = null;
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("USAGE-02: 加载失败——中文错误 + 重试按钮，重试成功后恢复数据展示", async () => {
  const base = new MockDataSource();
  let failing = true;
  injected.current = overrideSource(base, {
    getUsageSummary: () =>
      failing ? Promise.reject(new Error("用量服务离线")) : base.getUsageSummary(),
  });
  const app = await renderApp();
  const po = makeUsagePagePO(app.user);
  try {
    await po.openViaSidebar();
    const alert = await screen.findByRole("alert");
    // 原始错误文案不透出，走 errors.ts 场景映射
    expect(alert.textContent).toContain("用量数据加载失败，请重试。");
    expect(alert.textContent).not.toContain("用量服务离线");
    expect(screen.getByTestId("oc-usage-retry")).toBeTruthy();
    expect(po.totalCard()).toBeNull();

    failing = false;
    await po.retry();
    await po.ready();
    expect(po.errorAlert()).toBeNull();
    expect(po.sourceRow("main")).not.toBeNull();
    expect(po.totalCard()?.textContent ?? "").toContain(EXPECT.d30.total);
  } finally {
    injected.current = null;
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

/** 空汇总（与 IPC 契约同形状；空态 = calls=0 的合法响应，不是错误） */
function emptySummary(days: number): UsageSummaryView {
  return {
    days,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cacheHitRate: null,
    sessions: 0,
    turns: 0,
    calls: 0,
    byDay: [],
    byModel: [],
    bySource: [],
    byRole: [],
    byStatus: [],
  };
}
