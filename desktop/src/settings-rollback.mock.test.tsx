/**
 * L5 · P1 审计修复（§10-4）· 会话设置乐观更新失败回滚 Mock 渲染层回归。
 *
 * 缺陷：changeModel / changeThinkingLevel / changeToolMode 三处既有会话设置
 * 乐观更新写服务端失败后只弹错误提示，本地状态停留在未生效的新值上。
 * 修复：失败时重拉服务端真值（getSessionSettings）恢复本地状态。
 *
 * 覆盖（断言最终收敛态——同步 reject 时乐观帧与回滚帧合并在同一批渲染，
 * UI 从不显示未生效值；缺陷形态=滞留新值，修复形态=回到真值）：
 * - ROLLBACK-01 工具模式失败回滚（all→read-only 失败 → chip 收敛回 all）；
 * - ROLLBACK-02 思考级别失败回滚（high→low 失败 → chip 收敛回 high）；
 * - ROLLBACK-03 模型失败回滚（DeepSeek V3.2→Kimi K3 失败 → chip 收敛回 DeepSeek V3.2）；
 * - ROLLBACK-04 成功路径不回滚（写服务端成功 → 新值保持，恰好调用一次）；
 * - ROLLBACK-05 失败后错误提示呈现（错误行不吞掉失败）。
 * 判别力：禁用 rollback 调用后 01-03/05 的收敛断言失败（新值滞留）。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { renderApp, type AppSession } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";

const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

const DEMO_TITLE = "极简桌面原型";
const MOCK_MODEL_LABEL = "DeepSeek V3.2";
const OTHER_MODEL_LABEL = "Kimi K3";

async function openDemoSession(): Promise<AppSession> {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  await screen.findAllByText(/事件层、工作台与亮暗主题/);
  const row = sidebar.threadRow(DEMO_TITLE);
  if (row === null) throw new Error("演示会话行未找到");
  await app.user.click(row);
  await screen.findAllByText(/把桌面原型改成极简风格/);
  return app;
}

/** composer 三枚设置 chip 的驱动器：打开菜单并选择选项 */
function settingChipDriver(user: UserEvent, chipLabel: RegExp) {
  return async (menuName: string, optionLabel: string | RegExp) => {
    await user.click(screen.getByRole("button", { name: chipLabel }));
    const menu = screen.getByRole("menu", { name: menuName });
    await user.click(within(menu).getByRole("button", { name: optionLabel }));
  };
}

async function expectChip(user: UserEvent, label: RegExp): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });
}

afterEach(() => {
  injected.current = null;
});

describe("会话设置乐观更新失败回滚（P1 审计 §10-4）", () => {
  it("ROLLBACK-01: 工具模式写服务端失败 → 重拉真值，chip 收敛回 all", async () => {
    const base = new MockDataSource();
    injected.current = overrideSource(base, {
      updateSessionSettings: () => Promise.reject(new Error("注入：设置写入失败")),
    });
    const app = await openDemoSession();
    try {
      await settingChipDriver(app.user, /^all/)("工具模式", /^read-only/);
      // 收敛断言：新值不滞留（缺陷形态 = read-only 滞留，此断言超时失败）
      await expectChip(app.user, /^all/);
      expect(screen.queryByRole("button", { name: /^read-only/ })).toBeNull();
    } finally {
      app.unmount();
    }
  });

  it("ROLLBACK-02: 思考级别写服务端失败 → 重拉真值，chip 收敛回 high", async () => {
    const base = new MockDataSource();
    injected.current = overrideSource(base, {
      updateSessionSettings: () => Promise.reject(new Error("注入：设置写入失败")),
    });
    const app = await openDemoSession();
    try {
      await settingChipDriver(app.user, /^high/)("思考级别", "low");
      await expectChip(app.user, /^high/);
      expect(screen.queryByRole("button", { name: /^low/ })).toBeNull();
    } finally {
      app.unmount();
    }
  });

  it("ROLLBACK-03: 模型写服务端失败 → 重拉真值，chip 收敛回 DeepSeek V3.2", async () => {
    const base = new MockDataSource();
    injected.current = overrideSource(base, {
      updateSessionModel: () => Promise.reject(new Error("注入：模型写入失败")),
    });
    const app = await openDemoSession();
    try {
      await settingChipDriver(app.user, new RegExp(`^${MOCK_MODEL_LABEL}`))("模型", new RegExp(`^${OTHER_MODEL_LABEL}`));
      await expectChip(app.user, new RegExp(`^${MOCK_MODEL_LABEL}`));
      expect(screen.queryByRole("button", { name: new RegExp(`^${OTHER_MODEL_LABEL}`) })).toBeNull();
    } finally {
      app.unmount();
    }
  });

  it("ROLLBACK-04: 成功路径不回滚——chip 保持新值且恰好调用一次", async () => {
    const base = new MockDataSource();
    let calls = 0;
    injected.current = overrideSource(base, {
      updateSessionSettings: (sessionId, patch) => {
        calls += 1;
        return base.updateSessionSettings(sessionId, patch);
      },
    });
    const app = await openDemoSession();
    try {
      await settingChipDriver(app.user, /^all/)("工具模式", /^read-only/);
      await expectChip(app.user, /^read-only/);
      expect(calls).toBe(1);
      // 新值稳定保持（无回滚抖动）
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByRole("button", { name: /^read-only/ })).toBeTruthy();
    } finally {
      app.unmount();
    }
  });

  it("ROLLBACK-05: 失败后错误提示呈现（错误行不吞掉失败）", async () => {
    const base = new MockDataSource();
    injected.current = overrideSource(base, {
      updateSessionSettings: () => Promise.reject(new Error("注入：设置写入失败")),
    });
    const app = await openDemoSession();
    try {
      await settingChipDriver(app.user, /^all/)("工具模式", /^read-only/);
      // 错误行出现（errors.ts 稳定文案）；chip 同时被回滚
      await screen.findByText("工具模式更新失败，请重试。");
      await expectChip(app.user, /^all/);
    } finally {
      app.unmount();
    }
  });
});
