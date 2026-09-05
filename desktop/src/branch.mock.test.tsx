/**
 * L5 · 波次 B3 分支工作台 Mock 渲染层回归（BRANCH-01..06）。
 * 走完整 App 壳 + 生产 MockDataSource（分支演示会话脚本场景），覆盖：
 * - BRANCH-01 两视图分离：分支切换器列出分支（预览/当前高亮），线性 timeline 只呈现当前分支；
 * - BRANCH-02 timeline 导航：turnId 锚点节点存在，锚点元素可定位；
 * - BRANCH-03 分支切换：点击分支 → timeline 切换到该分支条目；
 * - BRANCH-04 编辑并重生成 / 重试（消息级操作）→ 新分支成为当前分支；
 * - BRANCH-05 运行中 409：流式期间切换 → 「会话正在运行，请先停止后再操作」+ 停止后可切换；
 * - BRANCH-06 Fork：新独立会话（标题 Fork 后缀）并自动导航。
 */
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp, type AppSession } from "../tests/fixtures/app-harness.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";

const DEMO_TITLE = "分支演示：重生成与 Fork";
const TURN1_TEXT = "帮我梳理桌面端亮暗主题的实现要点。";
const TURN2_TEXT = "那令牌具体怎么分层？";
const BRANCH_B_REPLY = "先用 data-theme 挂两套值，再把常用色收敛成语义令牌即可。";

async function openBranchDemo(): Promise<AppSession> {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  // 等 shell 就绪（初始 timeline 渲染）再切到分支演示会话
  await screen.findAllByText(/把桌面原型改成极简风格/);
  const row = sidebar.threadRow(DEMO_TITLE);
  if (row === null) throw new Error("分支演示会话行未找到");
  await app.user.click(row);
  await screen.findAllByText(TURN1_TEXT);
  return app;
}

it("BRANCH-01/02: 分支切换器列出两分支并高亮当前；timeline 导航节点带 turnId 锚点", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  try {
    // 当前分支（A）的内容在 timeline（轮次文本同时出现在导航摘要与消息正文）
    expect(screen.getAllByText(TURN2_TEXT).length).toBeGreaterThanOrEqual(1);

    // 分支切换器：当前分支 2 个
    const trigger = screen.getByTestId("oc-branch-switcher");
    expect(trigger.textContent).toContain("分支 2");
    await user.click(trigger);
    const menu = screen.getByTestId("oc-branch-menu");
    const current = within(menu).getByTestId("oc-branch-item-e-a2");
    expect(current.className).toContain("is-current");
    expect(within(current).getByText("当前")).toBeTruthy();
    expect(within(menu).getByTestId("oc-branch-item-e-a1b")).toBeTruthy();

    // timeline 导航：两个轮次节点（当前分支 A 两个 user 轮次），锚点元素存在
    const nav = screen.getByTestId("oc-timeline-nav");
    expect(within(nav).getByTestId("oc-timeline-node-turn-e-u1")).toBeTruthy();
    expect(within(nav).getByTestId("oc-timeline-node-turn-e-u2")).toBeTruthy();
    // 用户消息正文行（非导航摘要）带 data-anchor
    const msgBody = screen.getAllByText(TURN1_TEXT).find((node) => node.className === "msg-body");
    expect(msgBody?.closest("[data-anchor]")).not.toBeNull();
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});

it("BRANCH-03: 点击其他分支 → timeline 呈现该分支条目（两视图语义）", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  try {
    await user.click(screen.getByTestId("oc-branch-switcher"));
    await user.click(screen.getByTestId("oc-branch-item-e-a1b"));
    // timeline 切到分支 B 的根→叶（分支 A 的 turn2 不再出现）
    await screen.findByText("给我一个更小的方案：亮暗主题最少要做哪些事？");
    await screen.findByText(BRANCH_B_REPLY);
    expect(screen.queryByText(TURN2_TEXT)).toBeNull();
    // 导航节点只含分支 B 的轮次
    const nav = screen.getByTestId("oc-timeline-nav");
    expect(within(nav).getByTestId("oc-timeline-node-turn-e-u1b")).toBeTruthy();
    expect(within(nav).queryByTestId("oc-timeline-node-turn-e-u1")).toBeNull();
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});

it("BRANCH-04a: 用户消息「编辑并重生成」→ 行内编辑器 → 新分支成为当前分支", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  try {
    const actions = screen.getByTestId("oc-message-actions-e-u1");
    await user.click(within(actions).getByTestId("oc-message-edit-e-u1"));
    const editor = screen.getByTestId("oc-regenerate-editor");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(TURN1_TEXT);
    await user.clear(textarea);
    await user.type(textarea, "更小的方案：亮暗主题最少做哪些事？");
    await user.click(within(editor).getByTestId("oc-regenerate-confirm"));
    // 脚本场景：turn-e-u1 的重生成命中预置兄弟分支 e-a1b（成为当前分支）
    await screen.findByText(BRANCH_B_REPLY, { timeout: 3000 });
    const trigger = screen.getByTestId("oc-branch-switcher");
    await user.click(trigger);
    expect(within(screen.getByTestId("oc-branch-menu")).getByTestId("oc-branch-item-e-a1b").className).toContain("is-current");
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});

it("BRANCH-04b: 助手消息「重试」→ 以该轮原文重生成，产出新分支", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  try {
    const actions = screen.getByTestId("oc-message-actions-e-a2");
    await user.click(within(actions).getByTestId("oc-message-retry-e-a2"));
    // e-a2 解析到 turn-e-u2 用户条目；无预置兄弟 → 新建兄弟分支（timeline 重载为受控条目）
    await screen.findByText(/已按新的表述重新生成/, undefined, { timeout: 3000 });
    const trigger = screen.getByTestId("oc-branch-switcher");
    await user.click(trigger);
    expect(within(screen.getByTestId("oc-branch-menu")).getAllByRole("menuitem")).toHaveLength(3);
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});

it("BRANCH-05: 流式期间切换分支 → 409 文案 + 停止动作，停止后可切换", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  const composer = makeComposerPO(app.user);
  try {
    await composer.type("演示期间的问题");
    await composer.pressEnter();
    // mock sendPrompt 同步置 streaming（乐观用户条目出现即进入运行态）
    const trigger = screen.getByTestId("oc-branch-switcher");
    await user.click(trigger);
    await user.click(screen.getByTestId("oc-branch-item-e-a1b"));
    const strip = await screen.findByTestId("oc-branch-action-error");
    expect(strip.textContent).toContain("会话正在运行，请先停止后再操作");
    await user.click(within(strip).getByTestId("oc-branch-stop"));
    // mock abort 收敛流式态；菜单仍开，重试切换成功
    await user.click(screen.getByTestId("oc-branch-item-e-a1b"));
    await screen.findByText(BRANCH_B_REPLY, { timeout: 3000 });
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});

it("BRANCH-06: Fork 成独立会话 → 新会话行出现并自动选中", async () => {
  const app = await openBranchDemo();
  const user = app.user;
  const sidebar = makeSidebarPO(app.user);
  try {
    await user.click(screen.getByTestId("oc-branch-switcher"));
    await user.click(screen.getByTestId("oc-fork-button"));
    expect(sidebar.threadRow("分支演示：重生成与 Fork（Fork）")).not.toBeNull();
    // 新会话内容与源当前分支一致（chat-head 标题与侧栏行都显示 Fork 会话）
    await screen.findAllByText("分支演示：重生成与 Fork（Fork）", { selector: "strong" });
    expect(screen.getAllByText(TURN2_TEXT).length).toBeGreaterThanOrEqual(1);
  } finally {
    app.consoleTracker.restore();
    app.unmount();
  }
  app.consoleTracker.expectNoErrors();
});
