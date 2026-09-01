/**
 * L5 · SUB-01（Subagent Dock 列表/详情/错误态）Mock 渲染层回归。
 * 列表与详情用生产 MockDataSource；错误态注入 fixture（Mock 无失败分支，属注入表职责）。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { Dock } from "./components/Dock.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { trackConsoleErrors } from "../tests/fixtures/console.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeSubagentDockPO } from "../tests/fixtures/pages/subagent.js";

function renderSubagentDock(source: DesktopDataSource) {
  render(
    <Dock
      tool="subagent"
      onSelect={() => undefined}
      onClose={() => undefined}
      subagent={{ source, agentId: "yuan", sessionId: "desktop" }}
    />,
  );
}

it("SUB-01: Dock 列 threads → 选 thread → transcript/runs/messages/artifacts → 返回列表", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    renderSubagentDock(new MockDataSource());
    const po = makeSubagentDockPO(user);

    // 列表卡：标题/状态/模型/结果摘要/artifact 数
    await po.ready();
    const card = po.card("前端参考调研");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("closed");
    expect(card?.textContent).toContain("deepseek-v3.2");
    expect(card?.textContent).toContain("1 artifact");

    // 详情：objective / Runs / 消息 / Artifacts
    await po.openCard("前端参考调研");
    expect(await screen.findByText(/核对 openhanako/)).toBeTruthy();
    expect(po.sectionHeading(/^Runs · 1$/)).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "工作台" })).getByText("sar_mock01")).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "工作台" })).getByText("tools 9")).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "工作台" })).getByText("tokens 8200")).toBeTruthy();
    expect(po.sectionHeading(/^消息 · 3$/)).toBeTruthy();
    expect(po.sectionHeading(/^Artifacts · 1$/)).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "工作台" })).getByText("ui-research-notes.md")).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "工作台" })).getByText("2 KB")).toBeTruthy();

    // 返回列表
    await po.backToList();
    expect(po.card("前端参考调研")).not.toBeNull();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("SUB-01: 详情加载失败 → role=alert 与重试入口", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  const base = new MockDataSource();
  const source = overrideSource(base, {
    getSubagentTranscript: () => Promise.reject(new Error("详情服务不可达")),
  });
  try {
    renderSubagentDock(source);
    await screen.findByText("前端参考调研");
    await user.click(screen.getByRole("button", { name: /前端参考调研/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("详情服务不可达");
    expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});
