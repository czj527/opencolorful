/**
 * L5 · WS-01（新建会话对话框 toolMode=all 未确认 → 提交被拦）Mock 渲染层回归。
 * 注入记录型包装器断言「POST /api/sessions 不发出」（createThread 零调用）。
 */
import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeChathomePO } from "../tests/fixtures/pages/chathome.js";

const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

it("WS-01: toolMode=all 且未勾确认 → 对话框内报错，不创建会话", async () => {
  const base = new MockDataSource();
  const createThreadCalls: string[] = [];
  const source = overrideSource(base, {
    createThread: (agentId, title, options) => {
      createThreadCalls.push(`${agentId}:${title}:${options?.toolMode ?? "-"}`);
      return base.createThread(agentId, title, options);
    },
  });
  injected.current = source;
  const app = await renderApp();
  try {
    // 等初始数据 settle：时间线渲染 + 助理加载完成（defaultCwd 预填依赖 agents）
    await screen.findByText(/把桌面原型改成极简风格/);
    await makeSidebarPO(app.user).newThread();
    await screen.findByRole("button", { name: "打开 原 的档案页" });
    await makeChathomePO(app.user).openAdvancedNewSession();

    const dialog = screen.getByRole("dialog", { name: "高级新建会话" });
    const scoped = within(dialog);

    // 工作目录按 Agent defaultCwd 预填（矩阵链：填目录）
    const cwd = scoped.getByPlaceholderText("选择或输入工作目录") as HTMLInputElement;
    expect(cwd.value).toContain("opencolorful");

    // 工具模式切到 all → 出现确认勾选框（默认未勾选）
    await app.user.selectOptions(scoped.getByRole("combobox", { name: /工具模式/ }), "all");
    const checkbox = scoped.getByRole("checkbox", { name: /确认授权完整工具权限/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await app.user.click(scoped.getByRole("button", { name: "创建并进入会话" }));

    expect(scoped.getByRole("alert").textContent).toBe("完整工具模式需要确认工作区授权");
    expect(createThreadCalls).toEqual([]); // POST /api/sessions 不发出
    expect(screen.getByRole("dialog", { name: "高级新建会话" })).toBeTruthy(); // 弹窗保持，不误建会话
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});
