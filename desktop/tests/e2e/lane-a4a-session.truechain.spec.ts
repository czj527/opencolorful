/**
 * L6 真链 lane A4a · SESS-03 / SESS-04 / SESS-05（会话生命周期）。
 *
 * SESS-03：行内重命名（铅笔 → Enter 保存 / Esc 取消）→ PUT /api/sessions/:id/title
 *   双写（JSONL session header + SQLite 索引）；会话头同步；重启后从持久层重载一致。
 * SESS-04：归档无产品 UI 入口（矩阵既定链路：API 归档）→ DELETE /api/sessions/:id →
 *   已知限制 #7（侧栏不感知外部变更）→ 重启加载后归档区折叠展示 → 行内「恢复」→ unarchive API 真值。
 * SESS-05：会话设置 chips（toolMode/thinkingLevel/模型）切换 → PUT settings/model →
 *   GET 真值一致 → 重启后 chips 从持久层恢复。
 *
 * 真值对照（只读）：GET /api/sessions/:id、agents/<id>/sessions/*.jsonl 文本。
 */
import { expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import type { SessionViewWire } from "./fixtures/lane-a4a/api.js";
import { configureStubProvider, createAgentViaApi, createSessionViaApi } from "./fixtures/lane-a4a/provision.js";
import { LaneSidebarPO } from "./fixtures/lane-a4a/pages/l6-sidebar.js";

test.describe("@a4a SESS-03/04/05 会话生命周期真链", () => {
  /** 读 agents/<agentId>/sessions/*.jsonl 全文本（只读真值） */
  function readSessionJsonl(homeDir: string, agentId: string): string {
    const sessionsDir = path.join(homeDir, "agents", agentId, "sessions");
    expect(fs.existsSync(sessionsDir), "会话 JSONL 目录应存在").toBe(true);
    const files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
    expect(files.length, "至少一个会话 JSONL").toBeGreaterThanOrEqual(1);
    return files.map((name) => fs.readFileSync(path.join(sessionsDir, name), "utf8")).join("\n");
  }

  test("SESS-03: 行内重命名 Enter 保存 → 双写真值（JSONL+索引）→ 会话头同步 → 重启保持；Esc 取消不写", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-改名助理-${runId}`);
    const originalTitle = `oc-e2e-原名会话-${runId}`;
    const renamedTitle = `oc-e2e-改名后的标题-${runId}`;
    const session = await createSessionViaApi(harness, { agentId: agent.id, title: originalTitle });

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const sidebar = new LaneSidebarPO(page);

      await expect(page.locator(".chat-head-title strong")).toHaveText(originalTitle, { timeout: 30_000 });

      /* ---- Esc 取消：草稿丢弃，标题不变，服务端无写 ---- */
      await sidebar.startRename(originalTitle);
      await sidebar.renameInput().fill(`${renamedTitle}-取消`);
      await sidebar.cancelRename();
      await expect(sidebar.renameInput()).toHaveCount(0);
      await expect(page.locator(".chat-head-title strong")).toHaveText(originalTitle);
      const afterCancel = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(afterCancel.title).toBe(originalTitle);

      /* ---- Enter 保存：UI 两处同步 + 服务端双写真值 ---- */
      await sidebar.startRename(originalTitle);
      await sidebar.confirmRename(renamedTitle);
      await expect(sidebar.renameInput()).toHaveCount(0);
      await expect(page.locator(".chat-head-title strong")).toHaveText(renamedTitle, { timeout: 15_000 });
      await expect(sidebar.threadRow(renamedTitle)).toBeVisible();

      const renamed = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(renamed.title, "索引真值：PUT title 后 GET 应返回新标题").toBe(renamedTitle);
      expect(readSessionJsonl(harness.homeDir, agent.id), "JSONL 真值：会话头应写入新标题")
        .toContain(renamedTitle);

      /* ---- 重启：持久层重载后侧栏行 + 会话头一致 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      const sidebar2 = new LaneSidebarPO(page2);
      await expect(page2.locator(".chat-head-title strong")).toHaveText(renamedTitle, { timeout: 30_000 });
      await expect(sidebar2.threadRow(renamedTitle)).toBeVisible();
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("SESS-04: API 归档 → 重启后归档区折叠展示 → 行内「恢复」→ 回活跃列表 + unarchive 真值", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-归档助理-${runId}`);
    const title = `oc-e2e-归档会话-${runId}`;
    const session = await createSessionViaApi(harness, { agentId: agent.id, title });

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const sidebar = new LaneSidebarPO(page);
      await expect(page.locator(".chat-head-title strong")).toHaveText(title, { timeout: 30_000 });

      /* ---- API 归档（矩阵链路：归档无 Desktop UI 入口）---- */
      const archived = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(archived.archived).toBe(false);
      const deleteResult = await fetch(`${harness.serverUrl}/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      expect(deleteResult.ok, `DELETE 归档应成功：HTTP ${deleteResult.status}`).toBe(true);
      const afterDelete = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(afterDelete.archived, "归档后 archived 真值应为 true").toBe(true);

      /* ---- 已知限制 #7：侧栏不感知外部归档（无 SSE 失效刷新）→ 经重启加载 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      const sidebar2 = new LaneSidebarPO(page2);

      // 归档区折叠展示：开关 + 计数可见；折叠态看不到归档行；活跃列表无此会话（空态草稿）
      await expect(sidebar2.archivedToggle()).toBeVisible({ timeout: 30_000 });
      await expect(sidebar2.archivedCount()).toHaveText("1");
      await expect(sidebar2.threadRow(title)).toHaveCount(0);
      await expect(page2.getByText("发送首条消息后才会出现在会话列表")).toBeVisible();

      // 展开 → 归档行可见（归档行非 button role，仅展示 + 行内恢复）→ 行内恢复
      await sidebar2.archivedToggle().click();
      await expect(sidebar2.archivedRow(title)).toBeVisible();
      await sidebar2.unarchiveButton(title).click();

      // 恢复后：归档区消失，会话回活跃列表
      await expect(sidebar2.archivedToggle()).toHaveCount(0, { timeout: 15_000 });
      await expect(sidebar2.threadRow(title)).toBeVisible();

      // 服务端真值：unarchive 后 archived=false
      const afterRestore = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(afterRestore.archived, "恢复后 archived 真值应为 false").toBe(false);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("SESS-05: 会话设置 chips（模型/思考级别/工具模式）切换 → GET 真值一致 → 重启后 chips 保持", async ({ harness }) => {
    const runId = Date.now().toString(36);
    // 双模型 Provider：初始 chip 落在首个可用模型（a），切换目标为 b
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-chips助理-${runId}`);
    const title = `oc-e2e-chips会话-${runId}`;
    const session = await createSessionViaApi(harness, {
      agentId: agent.id,
      title,
      toolMode: "read-only",
      thinkingLevel: "medium",
    });

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);

      await expect(page.locator(".chat-head-title strong")).toHaveText(title, { timeout: 30_000 });
      // chips 初始态（会话设置加载完成锚点）
      await expect(page.getByRole("button", { name: "read-only", exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "medium", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "oc-e2e-model-a", exact: true })).toBeVisible();

      /* ---- 切模型：chip → 菜单 → oc-e2e-model-b ---- */
      await page.getByRole("button", { name: "oc-e2e-model-a", exact: true }).click();
      const modelMenu = page.getByRole("menu", { name: "模型" });
      await expect(modelMenu).toBeVisible();
      await modelMenu.getByRole("button", { name: /oc-e2e-model-b/ }).click();
      await expect(page.getByRole("button", { name: "oc-e2e-model-b", exact: true })).toBeVisible({ timeout: 15_000 });

      /* ---- 切思考级别：medium → low ---- */
      await page.getByRole("button", { name: "medium", exact: true }).click();
      const thinkingMenu = page.getByRole("menu", { name: "思考级别" });
      await expect(thinkingMenu).toBeVisible();
      await thinkingMenu.getByRole("button", { name: "low", exact: true }).click();
      await expect(page.getByRole("button", { name: "low", exact: true })).toBeVisible({ timeout: 15_000 });

      /* ---- 切工具模式：read-only → off ---- */
      await page.getByRole("button", { name: "read-only", exact: true }).click();
      const toolMenu = page.getByRole("menu", { name: "工具模式" });
      await expect(toolMenu).toBeVisible();
      await toolMenu.getByRole("button", { name: /^off/ }).click();
      await expect(page.getByRole("button", { name: "off", exact: true })).toBeVisible({ timeout: 15_000 });

      /* ---- 服务端真值：三 chip 与后端一致 ---- */
      const truth = await harness.apiGet<SessionViewWire>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(truth.model?.modelId, "模型 chip 写入 PUT /model").toBe("oc-e2e-model-b");
      expect(truth.thinkingLevel, "思考级别 chip 写入 PUT settings").toBe("low");
      expect(truth.toolMode, "工具模式 chip 写入 PUT settings").toBe("off");

      /* ---- 重启：chips 从持久层恢复 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      await expect(page2.locator(".chat-head-title strong")).toHaveText(title, { timeout: 30_000 });
      await expect(page2.getByRole("button", { name: "oc-e2e-model-b", exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page2.getByRole("button", { name: "low", exact: true })).toBeVisible();
      await expect(page2.getByRole("button", { name: "off", exact: true })).toBeVisible();
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
