/**
 * L5 · SET-01/02/03（设置页类目接线与外观/对话显示偏好）Mock 渲染层回归。
 * 生产 MockDataSource + local-prefs（localStorage）真实路径。
 */
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeSettingsPO } from "../tests/fixtures/pages/settings.js";

it("SET-01: 设置页四类目全部接线——外观 / 模型与 Provider / 对话显示 / 关于，无死类目", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    await sidebar.openSettings();
    expect(settings.dialog()).toBeTruthy();
    for (const label of ["外观", "模型与 Provider", "对话显示", "关于"]) {
      expect(settings.categoryButton(label)).not.toBeNull();
    }

    // 外观：主题三态 + 减少动效
    await settings.switchCategory("外观");
    expect(within(settings.dialog()).getByRole("group", { name: "主题" })).toBeTruthy();
    expect(settings.toggle("减少动效")).toBeTruthy();

    // 模型与 Provider：默认模型（来自服务端偏好）+ Provider 列表（异步加载后断言）
    await settings.switchCategory("模型与 Provider");
    expect(await within(settings.dialog()).findByLabelText("全局默认模型")).toBeTruthy();
    expect(await within(settings.dialog()).findByText("DeepSeek 本地")).toBeTruthy();
    expect(within(settings.dialog()).getByText("Moonshot")).toBeTruthy();

    // 对话显示：事件显隐开关
    await settings.switchCategory("对话显示");
    expect(settings.toggle("显示思考事件")).toBeTruthy();
    expect(settings.toggle("显示工具调用")).toBeTruthy();

    // 关于：版本与连接信息（无更新桥 → dev）
    await settings.switchCategory("关于");
    expect(within(settings.dialog()).getByText("桌面端")).toBeTruthy();
    expect(within(settings.dialog()).getByText("dev")).toBeTruthy();
    expect(within(settings.dialog()).getByText("离线 · mock 数据")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("SET-02: 对话显示开关即时过滤时间线并持久化（重启后保持）", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    // 等时间线加载：默认选中首个会话（极简桌面原型），时间线含思考与工具调用事件
    await screen.findByText(/把桌面原型改成极简风格/);
    expect(screen.getByText("思考")).toBeTruthy();
    expect(screen.getByText("工具调用")).toBeTruthy();

    await sidebar.openSettings();
    await settings.switchCategory("对话显示");
    expect(settings.toggle("显示思考事件").getAttribute("aria-checked")).toBe("true");

    await app.user.click(settings.toggle("显示思考事件"));
    expect(settings.toggle("显示思考事件").getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(window.localStorage.getItem("ocf-desktop-local-prefs") ?? "{}")).toMatchObject({
      showThinking: false,
    });

    await settings.close();
    expect(screen.queryByText("思考")).toBeNull(); // 即时生效：时间线不再渲染思考事件
    expect(screen.getByText("工具调用")).toBeTruthy(); // 工具事件不受影响
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();

  // 重启保持：同一 localStorage 下全新渲染仍隐藏思考事件
  app.unmount();
  const second = await renderApp();
  try {
    await screen.findByText(/把桌面原型改成极简风格/); // 等时间线重新装配
    expect(screen.queryByText("思考")).toBeNull();
    expect(screen.getByText("工具调用")).toBeTruthy();
  } finally {
    second.consoleTracker.restore();
  }
  second.consoleTracker.expectNoErrors();
});

it("SET-03: 外观主题三态 + 减少动效写入 html data 属性并持久化", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    await sidebar.openSettings();
    await settings.switchCategory("外观");

    await settings.setTheme("深色");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem("ocf-desktop-theme")).toBe("dark");

    await settings.setTheme("浅色");
    expect(document.documentElement.dataset["theme"]).toBe("light");

    await settings.setTheme("跟随系统");
    expect(window.localStorage.getItem("ocf-desktop-theme")).toBe("system");
    // matchMedia stub：prefers-color-scheme dark = false → 解析为浅色
    expect(document.documentElement.dataset["theme"]).toBe("light");

    await app.user.click(settings.toggle("减少动效"));
    expect(document.documentElement.dataset["reduceMotion"]).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("ocf-desktop-local-prefs") ?? "{}")).toMatchObject({
      reduceMotion: true,
    });

    await app.user.click(settings.toggle("减少动效"));
    expect(document.documentElement.dataset["reduceMotion"]).toBeUndefined();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});
