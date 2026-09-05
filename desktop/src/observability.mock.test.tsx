/**
 * L5 · OBS-01（日志页三 tab + 健康 badge）Mock 渲染层回归。
 * 生产 MockDataSource（fixtures 对齐 /api/observability/* 响应形状）。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { LogsPage } from "./pages/LogsPage.js";
import { MockDataSource } from "./data/mock-source.js";
import { trackConsoleErrors } from "../tests/fixtures/console.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeLogsPagePO } from "../tests/fixtures/pages/logs.js";

it("OBS-01: 日志页三 tab（活动/错误/安全审计）+ 健康 badge 渲染", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<LogsPage source={new MockDataSource()} />);
    const po = makeLogsPagePO(user);
    await po.ready();

    // 健康 badge：logger.failed=1、spool=2、epoch=4、disk=183MB；未降级/无丢弃则不渲染
    expect(po.healthBadge("写入失败 1")).not.toBeNull();
    expect(po.healthBadge("spool 待处理 2")).not.toBeNull();
    expect(po.healthBadge("Epoch 4")).not.toBeNull();
    expect(po.healthBadge("磁盘 183 MB")).not.toBeNull();
    expect(po.healthBadge("logger 降级")).toBeNull();
    expect(po.healthBadge("事件丢弃")).toBeNull();

    // 活动 tab：默认视图
    expect(screen.getByText("session.prompt.accepted")).toBeTruthy();

    // 错误 tab：分组与错误码
    await po.switchTab("错误");
    expect(screen.getByText("tool.failed")).toBeTruthy();
    expect(screen.getByText("PATTERN_TOO_BROAD")).toBeTruthy();

    // 安全审计 tab：账本行 + Epoch 过滤（只读）
    await po.switchTab("安全审计");
    expect(screen.getByText("sandbox.write.granted")).toBeTruthy();
    expect(screen.getAllByText("allowed").length).toBe(2);
    expect(screen.getByRole("combobox", { name: "Epoch 过滤" })).toBeTruthy();
    expect(screen.getByText("审计账本只读，无编辑或删除入口。")).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("OBS-01: 日志加载失败 → errors.ts 兜底中文错误 + 重试入口", async () => {
  const tracker = trackConsoleErrors();
  const base = new MockDataSource();
  const source = overrideSource(base, {
    getLogsData: () => Promise.reject(new Error("日志服务离线")),
  });
  try {
    render(<LogsPage source={source} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("日志加载失败，请重试。");
    expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});
