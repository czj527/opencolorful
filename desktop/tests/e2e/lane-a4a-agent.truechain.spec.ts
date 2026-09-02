/**
 * L6 真链 lane A4a · AGENT-03 / 04 / 05 / 06（档案页与多助理）。
 *
 * AGENT-03：档案页改名+改描述 → PUT /api/agents/:id（仅 name）+ PUT /api/agents/:id/base-color（persona）
 *   → identity.json / base-color.json 真值 → 重启后会话头 chip / 侧栏 badge / 档案页三处一致。
 *   已知观察：档案页保存后 App 的 agents 列表不刷新（agentsRefresh 仅引导/新建助理触发），
 *   侧栏 badge 与会话头 chip 的同名同步在重启（或重拉）后成立——本用例按此断言并在报告记录。
 * AGENT-04：人设（回复风格/人格标签）→ PUT base-color → 真值 + 重进保持 + 重启保持。
 * AGENT-05：记忆设置（启用整理/后台复盘/每日时间/最小空闲）→ PUT memory/settings（全量合并）→ 真值 + 重启保持。
 * AGENT-06：多助理空态 chips 切换归属 + 档案页/记忆页助理切换（记忆页 select）。
 *
 * 真值对照（只读）：GET /api/agents/:id、GET base-color、GET memory/settings、agents/<id>/*.json 文件。
 */
import { expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import type { AgentViewWire } from "./fixtures/lane-a4a/api.js";
import { configureStubProvider, createAgentViaApi, createSessionViaApi } from "./fixtures/lane-a4a/provision.js";
import { LaneProfilePO } from "./fixtures/lane-a4a/pages/l6-profile.js";

test.describe("@a4a AGENT-03..06 档案页与多助理真链", () => {
  /** 会话头助理 chip（点击进档案页）。限定在 chat-head 内，避免匹配到侧栏行的归属 badge。 */
  function headerChip(page: import("@playwright/test").Page, agentName: string) {
    return page.locator(".chat-head").getByRole("button", { name: new RegExp(agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  }

  test("AGENT-03: 档案页改名+改描述 → identity/base-color 真值 → 重启后 chip/badge/档案页一致", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agentA = await createAgentViaApi(harness, `oc-e2e-改名前-${runId}`);
    const agentB = await createAgentViaApi(harness, `oc-e2e-对照助理-${runId}`);
    const session = await createSessionViaApi(harness, {
      agentId: agentA.id,
      title: `oc-e2e-归属会话-${runId}`,
    });
    const renamed = `oc-e2e-改名后-${runId}`;
    const newDescription = `oc-e2e-新描述-${runId}：档案页改写后的底色人设。`;

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const profile = new LaneProfilePO(page);

      // 自动选中归属会话 → 会话头 chip = agentA（点 chip 进档案页）
      await expect(page.locator(".chat-head-title strong")).toHaveText(session.title, { timeout: 30_000 });
      await expect(headerChip(page, agentA.name)).toBeVisible({ timeout: 15_000 });
      await headerChip(page, agentA.name).click();
      await profile.expectReady(agentA.name);

      // 改名 + 改描述 → 保存 → 页面内 id 卡即时刷新（loadAll）
      await profile.renameAndDescribe(renamed, newDescription);
      await profile.expectIdCardName(renamed);

      /* ---- 服务端真值：identity.json.name + base-color.json.persona ---- */
      const view = await harness.apiGet<AgentViewWire>(`/api/agents/${encodeURIComponent(agentA.id)}`);
      expect(view.identity.name, "PUT /api/agents/:id 后 identity.name 应更新").toBe(renamed);
      expect(view.baseColor?.persona, "描述应写入 base-color.persona").toBe(newDescription);
      const baseColorPath = path.join(harness.homeDir, "agents", agentA.id, "base-color.json");
      const baseColor = JSON.parse(fs.readFileSync(baseColorPath, "utf8")) as { persona?: string };
      expect(baseColor.persona, "base-color.json 文件真值").toBe(newDescription);

      /* ---- 重启：会话头 chip / 侧栏 badge / 档案页三处一致 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      const profile2 = new LaneProfilePO(page2);

      await expect(page2.locator(".chat-head-title strong")).toHaveText(session.title, { timeout: 30_000 });
      // 会话头 chip（重启后 agents 重载，chip 名 = 新名）
      await expect(headerChip(page2, renamed)).toBeVisible({ timeout: 15_000 });
      // 侧栏 badge（≥2 助理时行内 badge 自标识归属）
      await expect(page2.locator(".thread-agent-badge")).toHaveText(renamed, { timeout: 15_000 });
      // 档案页
      await headerChip(page2, renamed).click();
      await profile2.expectReady(renamed);
      await profile2.expectIdCardName(renamed);
      // 对照助理不受影响（按 agentId 隔离）
      const other = await harness.apiGet<AgentViewWire>(`/api/agents/${encodeURIComponent(agentB.id)}`);
      expect(other.identity.name).toBe(agentB.name);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("AGENT-04: 档案页人设保存 → base-color 真值（replyStyle/personality）→ 重进保持 → 重启保持", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-人设助理-${runId}`);
    const newStyle = `先给结论再展开-${runId}`;

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const profile = new LaneProfilePO(page);

      // 无会话 → 空态身份证卡进档案页
      const card = page.getByRole("button", { name: `打开 ${agent.name} 的档案页` });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.click();
      await profile.expectReady(agent.name);

      // 保存人设：回复风格 + 人格标签（逗号分隔）
      await profile.savePersona(newStyle, "严谨，好奇");
      await expect(profile.personaFieldValue("回复风格")).toHaveValue(newStyle, { timeout: 15_000 });
      await expect(profile.personaFieldValue("人格标签")).toHaveValue(/严谨/);

      /* ---- 服务端真值 ---- */
      const baseColor = await harness.apiGet<{ replyStyle?: string; personality?: readonly string[] }>(
        `/api/agents/${encodeURIComponent(agent.id)}/base-color`,
      );
      expect(baseColor.replyStyle).toBe(newStyle);
      expect(baseColor.personality).toEqual(["严谨", "好奇"]);

      /* ---- 重进保持（导航离开后回来，字段从服务端重载）---- */
      await page.getByRole("button", { name: "对话" }).click();
      await expect(page.getByRole("button", { name: `打开 ${agent.name} 的档案页` })).toBeVisible();
      await page.getByRole("button", { name: `打开 ${agent.name} 的档案页` }).click();
      await expect(profile.personaFieldValue("回复风格")).toHaveValue(newStyle, { timeout: 15_000 });

      /* ---- 重启保持 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      const profile2 = new LaneProfilePO(page2);
      const card2 = page2.getByRole("button", { name: `打开 ${agent.name} 的档案页` });
      await expect(card2).toBeVisible({ timeout: 30_000 });
      await card2.click();
      await expect(profile2.personaFieldValue("回复风格")).toHaveValue(newStyle, { timeout: 15_000 });
      await expect(profile2.personaFieldValue("人格标签")).toHaveValue(/好奇/);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("AGENT-05: 档案页记忆设置保存 → memory/settings 真值 → 重启保持", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-记忆设置助理-${runId}`);

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const profile = new LaneProfilePO(page);

      const card = page.getByRole("button", { name: `打开 ${agent.name} 的档案页` });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.click();
      await profile.expectReady(agent.name);

      // 默认态锚点：启用整理 on（aria-pressed=true）
      const enableToggle = profile.memoryToggle("启用记忆整理");
      await expect(enableToggle).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });

      // 关闭启用整理 + 关闭后台复盘
      await enableToggle.click();
      await expect(profile.memoryToggle("启用记忆整理")).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
      await profile.memoryToggle("后台复盘").click();
      await expect(profile.memoryToggle("后台复盘")).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });

      // 每日整理时间 + 最小空闲分钟
      await profile.memoryDailyTime().fill("04:30");
      await profile.memoryMinIdle().fill("45");

      /* ---- 服务端真值（保存为 fire-and-forget 且写队列串行落盘 → 轮询等待收敛）---- */
      await expect
        .poll(
          async () =>
            (
              await harness.apiGet<{
                settings: { enabled: boolean; reviewEnabled: boolean; dailyRunTime: string; minIdleMinutes: number };
              }>(`/api/agents/${encodeURIComponent(agent.id)}/memory/settings`)
            ).settings,
          { timeout: 15_000 },
        )
        .toMatchObject({ enabled: false, reviewEnabled: false, dailyRunTime: "04:30", minIdleMinutes: 45 });

      /* ---- 重启保持 ---- */
      await closeApp(app);
      app = null;
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(app);
      const profile2 = new LaneProfilePO(page2);
      const card2 = page2.getByRole("button", { name: `打开 ${agent.name} 的档案页` });
      await expect(card2).toBeVisible({ timeout: 30_000 });
      await card2.click();
      await expect(profile2.memoryToggle("启用记忆整理")).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
      await expect(profile2.memoryToggle("后台复盘")).toHaveAttribute("aria-pressed", "false");
      await expect(profile2.memoryDailyTime()).toHaveValue("04:30");
      await expect(profile2.memoryMinIdle()).toHaveValue("45");
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("AGENT-06: 多助理空态 chips 切换归属 → 档案页/记忆页助理切换", async ({ harness }) => {
    const runId = Date.now().toString(36);
    await configureStubProvider(harness);
    const agentA = await createAgentViaApi(harness, `oc-e2e-多助理甲-${runId}`);
    const agentB = await createAgentViaApi(harness, `oc-e2e-多助理乙-${runId}`);

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);

      // 空态：≥2 助理 → 归属 chips 出现；默认草稿 = 助理列表首位（最近更新优先，不锚定创建顺序）
      await expect(page.getByRole("heading", { name: /要做什么，交给oc-e2e-多助理/ })).toBeVisible({ timeout: 30_000 });
      const chipA = page.locator(".empty-agents").getByRole("button", { name: agentA.name });
      const chipB = page.locator(".empty-agents").getByRole("button", { name: agentB.name });
      await expect(chipA).toBeVisible();
      await expect(chipB).toBeVisible();

      /* ---- 切换归属：点乙 chip → 身份证卡与空态标题跟随 ---- */
      await chipB.click();
      await expect(page.getByRole("heading", { name: `要做什么，交给${agentB.name}吧` })).toBeVisible();
      const cardB = page.getByRole("button", { name: `打开 ${agentB.name} 的档案页` });
      await expect(cardB).toBeVisible();

      /* ---- 档案页目标随入口切换 ---- */
      await cardB.click();
      await expect(page.getByText(`${agentB.name} 的身份证、人设与记忆管理。`)).toBeVisible({ timeout: 15_000 });

      /* ---- 记忆页助理切换（select）---- */
      await page.getByRole("button", { name: "记忆" }).click();
      const agentSelect = page.getByLabel("助理");
      await expect(agentSelect).toBeVisible({ timeout: 15_000 });
      // 默认跟随草稿推导 = 乙（当前 draftAgent）
      await expect(page.getByText(`${agentB.name} 的只读记忆视图`)).toBeVisible();
      await agentSelect.selectOption({ label: agentA.name });
      await expect(page.getByText(`${agentA.name} 的只读记忆视图`)).toBeVisible({ timeout: 15_000 });
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
