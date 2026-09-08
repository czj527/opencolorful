/**
 * L5 · P1 审计修复（§7.5/§10-10）· Mock 入口收口回归。
 *
 * 缺陷：Dock 的 Diff/Terminal 面板是纯静态演示（固定 dockFiles/固定文本），
 * 在真实 IPC 模式出现会让用户误以为查看了真实 Diff 或运行了真实 Terminal；
 * file 事件详情的「在右侧审查」按钮跳向演示 Diff；聊天审批按钮只改本地
 * state 且无演示标注。
 * 修复：Diff/Terminal 入口按钮与静态面板移除（Dock 收敛为 Subagent 检查器）；
 * 假跳转按钮移除；审批按钮区加「演示」标注。
 *
 * 覆盖：
 * - MOCK-GATE-01 会话头只剩 Subagent 一个工作台入口按钮（无 变更审查/终端）；
 * - MOCK-GATE-02 Subagent Dock 经唯一入口打开，检查器功能不受影响；
 * - MOCK-GATE-03 审批按钮区带「演示」chip（演示标注可见）。
 * 判别力：恢复三 tab tools 数组后 01 失败。
 */
import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { MockDataSource } from "./data/mock-source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeSubagentDockPO } from "../tests/fixtures/pages/subagent.js";

const injected = vi.hoisted(() => ({ current: null as import("./data/source.js").DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

afterEach(() => {
  injected.current = null;
});

it("MOCK-GATE-01: 会话头只剩 Subagent 一个工作台入口（变更审查/终端按钮不渲染）", async () => {
  injected.current = new MockDataSource();
  const app = await renderApp();
  try {
    await screen.findAllByText(/事件层、工作台与亮暗主题/);
    expect(screen.getByRole("button", { name: "Subagent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "变更审查" })).toBeNull();
    expect(screen.queryByRole("button", { name: "终端" })).toBeNull();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("MOCK-GATE-02: Subagent Dock 经唯一入口打开且功能不受影响", async () => {
  injected.current = new MockDataSource();
  const app = await renderApp();
  const user = app.user;
  try {
    await screen.findAllByText(/事件层、工作台与亮暗主题/);
    await user.click(screen.getByRole("button", { name: "Subagent" }));
    const po = makeSubagentDockPO(user);
    await po.ready();
    const dock = screen.getByRole("complementary", { name: "工作台" });
    expect(within(dock).getByText("closed")).toBeTruthy();
    // 收口后 Dock 内不再有 变更审查/终端 tab
    expect(within(dock).queryByText("变更审查")).toBeNull();
    expect(within(dock).queryByText("终端")).toBeNull();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("MOCK-GATE-03: 审批按钮区带「演示」标注（真实审批未接线的显式声明）", async () => {
  injected.current = new MockDataSource();
  const app = await renderApp();
  try {
    await screen.findByText("需要确认");
    const actions = screen.getByText("允许一次").closest(".approval-actions") as HTMLElement | null;
    if (actions === null) throw new Error("审批按钮区未找到");
    expect(within(actions).getByText("演示")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});
