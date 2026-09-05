/**
 * L5 · WS（Workspace 工作区）Mock 渲染层回归。
 * 矩阵行：WS-01（toolMode=all 未确认 → 提交被拦，A2 既有）；
 * A4a 追加：WS-02/WS-03 横幅可见状态机（L5 侧补充，行目标层 L6 另测）、WS-04 工作目录 chip。
 * 注入记录型包装器断言「POST /api/sessions 不发出」（createThread 零调用）。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
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

it("A7: 高级新建会话不会静默回退首个凭据模型", async () => {
  const base = new MockDataSource();
  const createThreadCalls: string[] = [];
  injected.current = overrideSource(base, {
    getPreferences: () => Promise.resolve({
      defaults: {
        model: { providerId: "openai", modelId: "gpt-5.2" },
        thinkingLevel: "medium",
        toolMode: "read-only",
      },
    }),
    createThread: (agentId, title, options) => {
      createThreadCalls.push(`${agentId}:${title}:${options?.toolMode ?? "-"}`);
      return base.createThread(agentId, title, options);
    },
  });
  const app = await renderApp();
  try {
    await screen.findByText(/把桌面原型改成极简风格/);
    await makeSidebarPO(app.user).newThread();
    await screen.findByRole("button", { name: "打开 原 的档案页" });
    await makeChathomePO(app.user).openAdvancedNewSession();

    const dialog = screen.getByRole("dialog", { name: "高级新建会话" });
    const scoped = within(dialog);
    const model = scoped.getByRole("combobox", { name: "模型" }) as HTMLSelectElement;
    expect(model.value).toBe("");

    await app.user.click(scoped.getByRole("button", { name: "创建并进入会话" }));
    expect(scoped.getByRole("alert").textContent).toBe("请选择模型");
    expect(createThreadCalls).toEqual([]);
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

/* ---- A4a：WS-02/WS-03 横幅可见状态机（L5 侧；行目标层 L6 由 lane-a4a-workspace 真链验证） ---- */

interface SettingsPatchRecord {
  readonly sessionId: string;
  readonly patch: { toolMode?: string; thinkingLevel?: string; workspaceConfirmed?: boolean };
}

/** 生产 Mock + 记录型 updateSessionSettings：断言横幅按钮发出的真实补丁 */
async function renderAppWithSettingsRecorder() {
  const base = new MockDataSource();
  const patches: SettingsPatchRecord[] = [];
  const source = overrideSource(base, {
    updateSessionSettings: (sessionId, patch) => {
      patches.push({ sessionId, patch });
      return base.updateSessionSettings(sessionId, patch);
    },
  });
  injected.current = source;
  const app = await renderApp();
  return { app, patches };
}

it("WS-02(L5): 会话 toolMode=all 未确认 → WorkspaceBanner 出现；点「确认工作区」→ 横幅消失并写 confirmed=true", async () => {
  const { app, patches } = await renderAppWithSettingsRecorder();
  try {
    // 生产 Mock 初始会话「极简桌面原型」：toolMode=all 且 workspaceConfirmed=false
    await screen.findByText(/把桌面原型改成极简风格/);
    const banner = await screen.findByRole("region", { name: "工作区确认" });
    expect(banner.textContent).toContain("当前会话可写入工作区，但目录尚未确认");
    expect(banner.textContent).toContain("opencolorful");

    await app.user.click(within(banner).getByRole("button", { name: "确认工作区" }));

    // 横幅消失（confirmed=true 后 showWorkspaceBanner=false）
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "工作区确认" })).toBeNull();
    });
    // 写出的补丁真值：workspaceConfirmed=true（工具解锁的服务端语义在 L6 对照）
    expect(patches.some((record) => record.patch.workspaceConfirmed === true)).toBe(true);
    // 工具模式 chip 保持 all（确认 ≠ 降级）
    expect(screen.getByRole("button", { name: "all" })).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("WS-03(L5): 横幅上点「切换为只读」→ 横幅消失、chip 变 read-only、写 toolMode=read-only", async () => {
  const { app, patches } = await renderAppWithSettingsRecorder();
  try {
    await screen.findByText(/把桌面原型改成极简风格/);
    const banner = await screen.findByRole("region", { name: "工作区确认" });

    await app.user.click(within(banner).getByRole("button", { name: "切换为只读" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "工作区确认" })).toBeNull();
    });
    expect(patches.some((record) => record.patch.toolMode === "read-only")).toBe(true);
    // Composer 工具模式 chip 跟随切换
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "read-only" })).toBeTruthy();
    });
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

/* ---- A4a：WS-04 工作目录 chip（L5 目标行）---- */

it("WS-04(L5): Composer 工作目录 chip 展示 basename（title 为完整路径）；无目录时「未设置工作目录」", async () => {
  const app = await renderApp();
  const lane = makeSessionLanePO(app.user);
  const sidebar = makeSidebarPO(app.user);
  try {
    // 已落库会话视图：workspaceCwd 来自会话设置 → chip = basename，title = 完整路径
    await screen.findByText(/把桌面原型改成极简风格/);
    const chip = await waitFor(() => {
      const found = lane.cwdChipByTitle("D:\\PI-study\\opencolorful");
      if (found === null) throw new Error("工作目录 chip 尚未渲染");
      return found;
    });
    expect(chip.textContent).toBe("opencolorful");

    // 草稿视图跟随草稿助理的 defaultCwd
    await sidebar.newThread();
    expect(lane.cwdChipText()).toBe("opencolorful");

    // 切到无 workspace 的助理（紫藤）→ 空目录兜底文案；chip 为占位展示控件（无 button 语义）
    await app.user.click(screen.getByRole("button", { name: "紫藤" }));
    await waitFor(() => {
      expect(lane.cwdChipText()).toBe("未设置工作目录");
    });
    expect(screen.queryByRole("button", { name: "未设置工作目录" })).toBeNull();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});
