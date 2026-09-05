/**
 * L5 · COMPACT-01（草稿会话输入 /compact 被前端拦截）Mock 渲染层回归。
 * 生产 MockDataSource：草稿态（NEW_THREAD）不发 compactSession，本地给出中文拦截文案。
 */
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";

it("COMPACT-01: 草稿会话输入 /compact → 拦截文案「先发送消息创建会话」，不创建会话", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const composer = makeComposerPO(app.user);
  try {
    // 等初始数据 settle：会话设置链路就绪（chip 显示会话模型）后再进草稿
    await screen.findByText(/把桌面原型改成极简风格/);
    await screen.findByText("DeepSeek V3.2");

    await sidebar.newThread();
    // 草稿视图的模型 chip 显示偏好默认模型（models + preferences 已就绪）
    await screen.findByText("Kimi K3");
    await composer.type("/compact");
    await composer.pressEnter();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("先发送消息创建会话");

    // 输入未被清空（不进入压缩/发送链路），也没有会话被创建进侧栏
    expect(composer.textbox().value).toBe("/compact");
    expect(sidebar.threadRow("/compact")).toBeNull();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});
