/**
 * L5 · SESS（Session 创建与生命周期）Mock 渲染层回归。
 * 矩阵行：SESS-02（草稿空态 → 首条消息落库，A2 既有）；
 * A4a 追加：SESS-03 行内重命名（L5 侧）、SESS-04 归档区/恢复（L5 侧）、
 * SESS-01 missing-cwd 锚点的 L5 视角（快捷草稿路径不带 cwd 选项可建会话 + 高级表单空目录拦截）。
 * 生产 MockDataSource：草稿不落库；发首条消息后侧栏出现新会话行。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";
import { makeChathomePO } from "../tests/fixtures/pages/chathome.js";
import { makeSessionLanePO } from "../tests/fixtures/lane-a4a/session-lane.js";

const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

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

/* ---- A4a：SESS-03 行内重命名（L5 侧；JSONL+SQLite 双写真值在 L6 对照） ---- */

it("SESS-03(L5): 铅笔行内重命名 Enter 保存 → 侧栏行与会话头同步；Esc 取消、空标题不保存", async () => {
  const app = await renderApp();
  const lane = makeSessionLanePO(app.user);
  const renamed = "oc-l5-改名后的会话标题";
  const rowByName = (fragment: string): HTMLElement | null =>
    screen.queryByRole("button", { name: new RegExp(fragment.replace(/[.*+?${}()|[\]\\]/g, "\\$&")) });
  try {
    // 启动自动选中首个会话「极简桌面原型」：会话头 strong 与侧栏行同题
    await screen.findByText(/把桌面原型改成极简风格/);
    await waitFor(() => {
      const header = document.querySelector(".chat-head-title strong");
      if (header?.textContent !== "极简桌面原型") throw new Error("会话头尚未就绪");
    });

    // Enter 保存：侧栏行 + 会话头两处同步
    await lane.startRename("极简桌面原型");
    await app.user.clear(lane.renameInput());
    await app.user.type(lane.renameInput(), `${renamed}{Enter}`);
    await waitFor(() => {
      const header = document.querySelector(".chat-head-title strong");
      expect(header?.textContent).toBe(renamed);
    });
    expect(rowByName(renamed)).not.toBeNull();
    expect(rowByName("极简桌面原型")).toBeNull();

    // Esc 取消：草稿丢弃，标题回退当前值
    await lane.startRename(renamed);
    await app.user.type(lane.renameInput(), "（这行不该被保存）");
    await app.user.type(lane.renameInput(), "{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "编辑会话标题" })).toBeNull();
    });
    expect(rowByName(renamed)).not.toBeNull();

    // 空标题 Enter：不写后端、不产生空标题行
    await lane.startRename(renamed);
    await app.user.clear(lane.renameInput());
    await app.user.type(lane.renameInput(), "{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "编辑会话标题" })).toBeNull();
    });
    expect(rowByName(renamed)).not.toBeNull();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

/* ---- A4a：SESS-04 归档区/恢复（L5 可见状态；归档写路径 DELETE /api/sessions/:id 由 L6 对照） ---- */

it("SESS-04(L5): 归档区折叠展示 → 展开可见归档行 → 行内「恢复」回到活跃列表", async () => {
  const app = await renderApp();
  const lane = makeSessionLanePO(app.user);
  const archivedTitle = "已归档会话演示";
  try {
    await screen.findByText(/把桌面原型改成极简风格/);

    // 归档区默认折叠：开关与计数可见，归档行不可见
    const toggle = await waitFor(() => {
      const found = lane.archivedToggle();
      if (found === null) throw new Error("归档区尚未渲染");
      return found;
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(lane.archivedCount()).toBe("1");
    expect(screen.queryByText(archivedTitle)).toBeNull();

    // 展开 → 归档行 + 恢复按钮
    await app.user.click(toggle);
    const restoredRow = screen.getByText(archivedTitle);
    expect(restoredRow).not.toBeNull();

    // 行内恢复 → 归档区消失，会话回到活跃列表
    await app.user.click(lane.unarchiveButton(archivedTitle));
    await waitFor(() => {
      expect(lane.archivedToggle()).toBeNull();
    });
    expect(screen.getByRole("button", { name: new RegExp(archivedTitle) })).not.toBeNull();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

/* ---- A4a：SESS-01 missing-cwd 锚点（L5 视角）：快捷路径不带 cwd 选项；高级表单空目录拦截 ---- */

it("SESS-01(L5): 快捷草稿首条消息以无 cwd 选项创建会话（服务端兜底）；高级表单空目录被本地拦截", async () => {
  const base = new MockDataSource();
  const createThreadCalls: Array<{ agentId: string; title: string; hasCwdOption: boolean }> = [];
  const source = overrideSource(base, {
    createThread: (agentId, title, options) => {
      createThreadCalls.push({ agentId, title, hasCwdOption: options?.cwd !== undefined });
      return base.createThread(agentId, title, options);
    },
  });
  injected.current = source;
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const composer = makeComposerPO(app.user);
  const chathome = makeChathomePO(app.user);
  try {
    await screen.findByText(/把桌面原型改成极简风格/);

    // 快捷路径（侧栏 +）：创建请求不带 cwd —— cwd 由服务端三级兜底解析（SESS-01 锚点的客户端半边）
    await sidebar.newThread();
    await composer.type("oc-l5-免目录会话锚点");
    await composer.pressEnter();
    await waitFor(() => {
      expect(sidebar.threadRow("oc-l5-免目录会话锚点")).not.toBeNull();
    });
    expect(chathome.draftCopy).toBeDefined();
    expect(screen.queryByText("新会话为草稿：发送首条消息后才会出现在会话列表")).toBeNull();
    expect(createThreadCalls).toEqual([
      { agentId: "yuan", title: "oc-l5-免目录会话锚点", hasCwdOption: false },
    ]);

    // 负向：高级新建表单清空工作目录 → 本地拦截「请填写工作目录」，不发出创建请求
    await sidebar.newThread();
    await screen.findByRole("button", { name: "打开 原 的档案页" });
    await chathome.openAdvancedNewSession();
    const dialog = screen.getByRole("dialog", { name: "高级新建会话" });
    const scoped = within(dialog);
    const cwd = scoped.getByPlaceholderText("选择或输入工作目录") as HTMLInputElement;
    await app.user.clear(cwd);
    await app.user.click(scoped.getByRole("button", { name: "创建并进入会话" }));
    expect(scoped.getByRole("alert").textContent).toBe("请填写工作目录");
    expect(createThreadCalls).toHaveLength(1); // 拦截路径不新增 createThread 调用
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});
