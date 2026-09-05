/**
 * L5 · SHELL（Desktop 外壳与全局状态）Mock 渲染层回归。
 * 矩阵行：SHELL-01（Mock 回退横幅）/ SHELL-03（主题 data 属性）/ SHELL-05（侧栏折叠）。
 * 数据源：生产 MockDataSource（happy-dom 无 desktopApi 桥 → createDataSource 自然回退 mock）。
 */
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeTitlebarPO } from "../tests/fixtures/pages/titlebar.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";

it("SHELL-01: 桥不存在时回退 Mock 数据源——首屏显示演示横幅与离线连接标签", async () => {
  const app = await renderApp();
  try {
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe("当前为演示数据（后端未连接），功能仅供预览");
    // Titlebar 连接指示与 Mock ConnectionInfo 一致（mock：connected=false）
    expect(screen.getByText("离线 · mock 数据")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("SHELL-03: 主题 data 属性即时生效——初始 system(浅色)，切换后 html[data-theme]/colorScheme 同步", async () => {
  const app = await renderApp();
  const titlebar = makeTitlebarPO(app.user);
  try {
    // setup 的 matchMedia stub matches=false → system 解析为 light；减少动效默认关闭
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(document.documentElement.dataset["reduceMotion"]).toBeUndefined();

    await titlebar.toggleTheme();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(titlebar.themeToggleAriaLabel()).toBe("切换为浅色主题");

    await titlebar.toggleTheme();
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(titlebar.themeToggleAriaLabel()).toBe("切换为深色主题");
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("SHELL-05: 侧栏折叠为 rail，折叠状态跨页面导航保持，可再展开", async () => {
  const app = await renderApp();
  const titlebar = makeTitlebarPO(app.user);
  const sidebar = makeSidebarPO(app.user);
  try {
    await sidebar.collapse();
    expect(sidebar.isCollapsed()).toBe(true);
    expect(sidebar.isExpanded()).toBe(false);

    // 折叠状态在切页后保持（App 内存态，路由不重建壳）
    await titlebar.goto("记忆");
    expect(await screen.findByRole("heading", { name: "记忆" })).toBeTruthy();
    expect(sidebar.isCollapsed()).toBe(true);
    await titlebar.goto("对话");
    expect(sidebar.isCollapsed()).toBe(true);

    await sidebar.expand();
    expect(sidebar.isCollapsed()).toBe(false);
    expect(sidebar.isExpanded()).toBe(true);
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});
