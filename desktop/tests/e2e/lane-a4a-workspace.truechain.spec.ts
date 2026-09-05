/**
 * L6 真链 lane A4a · WS-02 / WS-03（工作区确认横幅）。
 *
 * 链路：横幅按钮 → App.updateSessionSettings → IPC PUT /api/sessions/:id/settings
 *   → SQLite 会话索引（workspaceConfirmed / toolMode）→ UI 横幅消失 + chip 状态。
 * 前置数据经 API 准备（stub Provider + 助理 + toolMode=all 且未确认的会话），
 * 启动后 App 自动选中该会话（threads[0]），横幅即出现（SEC-01 fail-safe 语义的产品侧入口）。
 *
 * 真值对照（只读）：GET /api/sessions/:id 的 settings 字段；重启后重新加载验证持久化。
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import { apiSend, type SessionViewWire } from "./fixtures/lane-a4a/api.js";
import { configureStubProvider, createAgentViaApi, createSessionViaApi } from "./fixtures/lane-a4a/provision.js";

test.describe("@a4a WS-02/WS-03 工作区横幅真链", () => {
  test("WS-02: toolMode=all 未确认 → 横幅出现 → 点「确认工作区」→ confirmed=true 真值 + 重启保持不回横幅", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-确认助理-${runId}`);
    const wsDir = path.join(harness.runRoot, "oc-e2e-ws-confirm");
    fs.mkdirSync(wsDir, { recursive: true });
    const session = await createSessionViaApi(harness, {
      agentId: agent.id,
      title: `oc-e2e-确认会话-${runId}`,
      cwd: wsDir,
      toolMode: "all",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
    });

    // 前置真值：all 且未确认
    const before = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
    expect(before.toolMode).toBe("all");
    expect(before.workspaceConfirmed).toBe(false);

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);

      // 自动选中唯一会话 → 会话头出现 → 横幅出现（含 cwd）
      await expect(page.locator(".chat-head-title strong")).toHaveText(session.title, { timeout: 30_000 });
      const banner = page.getByRole("region", { name: "工作区确认" });
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText("当前会话可写入工作区，但目录尚未确认");
      await expect(banner).toContainText(wsDir);

      // 确认工作区 → 横幅消失；工具模式 chip 保持 all
      await banner.getByRole("button", { name: "确认工作区" }).click();
      await expect(banner).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "all", exact: true })).toBeVisible();

      // 服务端真值：confirmed=true 已持久化
      const after = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(after.workspaceConfirmed, "确认后服务端应为 confirmed=true").toBe(true);
      expect(after.toolMode).toBe("all");

      /* ---- 重启：confirmed 持久化，横幅不再出现 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      await expect(page2.locator(".chat-head-title strong")).toHaveText(session.title, { timeout: 30_000 });
      // 设置加载完成的锚点：工具模式 chip 显示 all（来自会话设置而非草稿默认）
      await expect(page2.getByRole("button", { name: "all", exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page2.getByRole("region", { name: "工作区确认" })).toHaveCount(0);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("WS-03: 横幅上点「切换为只读」→ toolMode=read-only 真值 + chip 变 read-only + 横幅消失", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-只读助理-${runId}`);
    const wsDir = path.join(harness.runRoot, "oc-e2e-ws-readonly");
    fs.mkdirSync(wsDir, { recursive: true });
    const session = await createSessionViaApi(harness, {
      agentId: agent.id,
      title: `oc-e2e-只读会话-${runId}`,
      cwd: wsDir,
      toolMode: "all",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
    });

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page: Page = await firstWindow(app);

      await expect(page.locator(".chat-head-title strong")).toHaveText(session.title, { timeout: 30_000 });
      const banner = page.getByRole("region", { name: "工作区确认" });
      await expect(banner).toBeVisible({ timeout: 15_000 });

      // 切换为只读 → 横幅消失；Composer 工具模式 chip 变 read-only
      await banner.getByRole("button", { name: "切换为只读" }).click();
      await expect(banner).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "read-only", exact: true })).toBeVisible({ timeout: 15_000 });

      // 服务端真值：toolMode=read-only；未确认状态保持（不因降级被偷偷置真）
      const after = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(after.toolMode, "切换只读后服务端 toolMode 应为 read-only").toBe("read-only");
      expect(after.workspaceConfirmed, "降级只读不应顺带确认工作区").toBe(false);

      // 横幅不回潮：无 all 模式则横幅条件不成立
      await expect(page.getByRole("region", { name: "工作区确认" })).toHaveCount(0);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("WS-03 负向: toolMode=all 未确认时 PUT settings 携带 cwd 变更且未确认 → 服务端 400 拦截", async ({ harness }) => {
    // 语义锚（session-settings fail-closed）：cwd 变更 + 写权限 + 未确认 → 拒绝。
    // 桌面 UI 无该入口（Composer cwd chip 无 handler），此处以 API 面固化服务端契约，
    // 防止未来 UI 直接放行 cwd 变更而绕过横幅确认。
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-负向助理-${runId}`);
    const wsDir = path.join(harness.runRoot, "oc-e2e-ws-negative");
    const otherDir = path.join(harness.runRoot, "oc-e2e-ws-negative-2");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    const session = await createSessionViaApi(harness, {
      agentId: agent.id,
      title: `oc-e2e-负向会话-${runId}`,
      cwd: wsDir,
      toolMode: "all",
      workspaceConfirmed: false,
    });
    const result = await apiSend<unknown>(harness.serverUrl, "PUT", `/api/sessions/${encodeURIComponent(session.id)}/settings`, {
      workspaceCwd: otherDir,
    });
    expect(result.status, "未确认的 cwd 变更必须被拒绝").toBe(400);
  });
});
