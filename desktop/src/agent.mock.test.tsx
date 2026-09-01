/**
 * L5 · AGENT-02（空态身份证卡）Mock 渲染层回归。
 * 生产 MockDataSource：点「新建会话」进入草稿空态 → 身份证卡展示/复制编号/进档案页。
 * 复制用 happy-dom 真实 clipboard（writeText→readText 回读），不断言桩调用而断言可见结果。
 */
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeChathomePO } from "../tests/fixtures/pages/chathome.js";

it("AGENT-02: 身份证卡展示名称/编号/状态/描述；点「编号」复制；点卡进档案页", async () => {
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const chathome = makeChathomePO(app.user);
    const card = await screen.findByRole("button", { name: "打开 原 的档案页" });

    // 字段行（row 文本 = 标签 + 值，不依赖样式类）
    const rowText = (label: string): string => {
      const labelEl = within(card).getByText(label);
      return labelEl.parentElement?.textContent ?? "";
    };
    expect(rowText("名称")).toBe("名称原");
    expect(rowText("编号")).toBe("编号yuan");
    expect(rowText("状态")).toBe("状态离线"); // mock ConnectionInfo connected=false
    expect(rowText("描述")).toBe("描述在代码、记忆与长期计划之间保持连续性。");

    // 点「编号」复制完整 id：出现「已复制」反馈，且真实剪贴板内容一致
    await app.user.click(within(card).getByRole("button", { name: "yuan" }));
    expect(within(card).getByText("已复制")).toBeTruthy();
    const clipboard = (window.navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard;
    expect(await clipboard.readText()).toBe("yuan");

    // 点卡进档案页（可编辑：source 已接线）
    await chathome.openProfile("原");
    expect(screen.getByRole("heading", { name: "助理档案" })).toBeTruthy();
    expect(screen.getByText("原 的身份证、人设与记忆管理。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

