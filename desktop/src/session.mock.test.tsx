/**
 * L5 · SESS-02（草稿空态文案 → 首条消息后进入会话列表）Mock 渲染层回归。
 * 生产 MockDataSource：草稿不落库；发首条消息后侧栏出现新会话行。
 */
import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";
import { makeChathomePO } from "../tests/fixtures/pages/chathome.js";

it("SESS-02: 侧栏新建会话 → 草稿空态文案；首条消息后会话出现在列表", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const composer = makeComposerPO(app.user);
  const chathome = makeChathomePO(app.user);
  try {
    // 等初始数据 settle：会话设置链路就绪（chip 显示会话模型）后再进草稿
    await screen.findByText(/把桌面原型改成极简风格/);
    await screen.findByText("DeepSeek V3.2");

    await sidebar.newThread();
    // 草稿视图的模型 chip 显示偏好默认模型（models + preferences 已就绪）
    await screen.findByText("Kimi K3");

    // 草稿态文案（产品决策 #1：首发消息才落库），且列表中没有草稿行
    expect(chathome.draftCopy().textContent).toBe("新会话为草稿：发送首条消息后才会出现在会话列表");
    expect(sidebar.threadRow("第一条草稿消息")).toBeNull();

    await composer.type("第一条草稿消息");
    await composer.pressEnter();

    // 首条消息创建会话并进入侧栏；草稿文案消失
    await waitFor(() => {
      expect(sidebar.threadRow("第一条草稿消息")).not.toBeNull();
    });
    expect(screen.queryByText("新会话为草稿：发送首条消息后才会出现在会话列表")).toBeNull();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});
