/**
 * P1 审计 §8 人工验收巡演 · 波次 A（A-1 ~ A-6）视觉证据采集器（@acceptance）。
 *
 * 非 断言型回归：驱动真实 Electron 应用走完各验收卡旅程，在每个关键步骤
 * 截图落盘 desktop/test-artifacts/acceptance-tour/<卡号>/<两位序号>-<slug>.png，
 * 由主 Agent 逐张审图。卡片语义 human-fixed（docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md §8）。
 *
 * 约束（任务 Brief）：
 * - 断言先于截图：每张截图前必须有对关键元素的可见性断言（截图 = 预期状态）；
 * - 只用 lane-a4b stub 与 fakeApiKey，禁止真实 Provider 网络/真实 Key；
 * - UI 无对应入口时不改生产代码，截最近真实状态并在 REPORT.md 记 GAP；
 * - Agent 名/消息文本一律 oc-e2e-验收- 前缀；每个用例末尾保留隔离自检。
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import os from "node:os";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { REPO_ROOT } from "./fixtures/backend.js";
import type { LaneBackendHarness } from "./fixtures/lane-a4b/backend.js";
import { test } from "./fixtures/lane-a4b/harness.js";
import { serverAuthHeaders } from "./fixtures/server-token.js";
import { LaneMemoryPO } from "./fixtures/lane-a4d/pages/l6-memory.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
/** stub fast 模式的完整回复（lane-a4b server-bootstrap.ts DEFAULT_TEXT） */
const FAST_REPLY = "oc-e2e-lane回复：A4b 真链回归的完整回复，用于验证定稿与持久化。";

const TOUR_DIR = path.join(REPO_ROOT, "desktop", "test-artifacts", "acceptance-tour");

/** 巡演截图：<卡号>/<两位序号>-<slug>.png（Playwright 自动创建父目录） */
async function shot(page: Page, card: string, file: string): Promise<void> {
  await page.screenshot({ path: path.join(TOUR_DIR, card, file) });
}

/** 动画收敛等待（Brief 上限 300ms；状态等待一律用 expect 轮询） */
async function settleAnimation(page: Page, ms = 300): Promise<void> {
  await page.waitForTimeout(ms);
}

/** 把全局默认模型固定到本地 stub（与 lane-a4b-chat 同法） */
async function pinDefaultModelToStub(lane: LaneBackendHarness): Promise<void> {
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length, "引导后应至少一个自定义 Provider").toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  const response = await fetch(`${lane.serverUrl}/api/settings/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...serverAuthHeaders(lane.homeDir) },
    body: JSON.stringify({ defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } } }),
  });
  expect(response.ok, `PUT preferences 应成功：${response.status}`).toBe(true);
}

/** 引导建助理 + 固定默认模型，返回对话页 PO（A-1 之外复用；不逐步截图） */
async function setupChat(lane: LaneBackendHarness, app: ElectronApplication, agentName: string): Promise<{ page: Page; chat: ChatPO }> {
  const page = await firstWindow(app);
  const onboarding = new OnboardingPO(page);
  await onboarding.expectStepAssistantVisible();
  await onboarding.completeAllSteps({
    name: agentName,
    apiKey: lane.fakeApiKey,
    baseUrl: lane.stubUrl,
    modelId: STUB_MODEL_ID,
  });
  await pinDefaultModelToStub(lane);
  const chat = new ChatPO(page);
  await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
  return { page, chat };
}

/** 隔离自检（desktop-test-conventions §五.1）：home 与 user-data 必须位于临时目录 */
function expectIsolated(lane: LaneBackendHarness): void {
  expect(lane.homeDir.startsWith(os.tmpdir()), "OPENCOLORFUL_HOME 必须位于临时目录").toBe(true);
  expect(lane.userDataDir.startsWith(os.tmpdir()), "user-data-dir 必须位于临时目录").toBe(true);
}

test.describe("@acceptance 验收巡演 · 波次 A（lane-a4b）", () => {

  test("A-1 首次使用：四步引导逐步截图 → 首条消息流式/完成 → 外观/主题/侧栏视觉捕获", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A1-${Date.now().toString(36)}`;
    const firstMessage = `oc-e2e-验收-首条消息-A1-${Date.now().toString(36)}`;

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const page = await firstWindow(app);
      const onboarding = new OnboardingPO(page);

      /* ---- 第 1 步：助理命名 ---- */
      await onboarding.expectStepAssistantVisible();
      await shot(page, "A-1", "01-onboarding-step1-assistant.png");
      await page.getByLabel("名字").fill(agentName);
      await page.getByRole("button", { name: "下一步" }).click();

      /* ---- 第 2 步：接入模型 ---- */
      await expect(page.getByRole("heading", { name: "接入模型" })).toBeVisible({ timeout: 15_000 });
      await shot(page, "A-1", "02-onboarding-step2-provider.png");
      await page.getByRole("radio", { name: /自定义/ }).click();
      await page.getByLabel("API Key").fill(lane.fakeApiKey);
      await page.getByText("高级设置（Base URL / 模型）").click();
      await page.getByLabel("Base URL").fill(lane.stubUrl);
      await page.getByLabel("模型 ID").fill(STUB_MODEL_ID);
      await page.getByRole("button", { name: "下一步" }).click();

      /* ---- 第 3 步：工作目录 ---- */
      await expect(page.getByRole("heading", { name: "选一个工作目录" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("暂不设置：助理仍可对话")).toBeVisible();
      await shot(page, "A-1", "03-onboarding-step3-directory.png");
      await page.getByRole("button", { name: "下一步" }).click();

      /* ---- 第 4 步：权限说明 ---- */
      await expect(page.getByRole("heading", { name: "它能做什么、不能做什么" })).toBeVisible({ timeout: 15_000 });
      await shot(page, "A-1", "04-onboarding-step4-permissions.png");
      await page.getByRole("button", { name: "完成，开始对话" }).click();
      await onboarding.expectHidden(30_000);

      /* ---- 完成进对话空态 ---- */
      await pinDefaultModelToStub(lane);
      await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
      await shot(page, "A-1", "05-chat-empty-state.png");

      /* ---- 首条消息：流式中截图 → 完成态截图（fast 模式放缓分片节奏，留出流式观察窗） ---- */
      const chat = new ChatPO(page);
      await lane.setStub({ mode: "fast", chunks: 12, intervalMs: 250, text: FAST_REPLY });
      await chat.fill(firstMessage);
      await chat.send();
      await chat.expectStreaming(30_000);
      await shot(page, "A-1", "06-first-message-streaming.png");
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);
      await chat.expectDraftNoticeGone();
      await shot(page, "A-1", "07-first-message-complete.png");

      /* ---- 附加捕获 1：设置页外观类目 ---- */
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settingsDialog = page.getByRole("dialog", { name: "设置" });
      await expect(settingsDialog).toBeVisible({ timeout: 15_000 });
      await settingsDialog.getByRole("button", { name: "外观" }).click();
      await expect(settingsDialog.getByRole("heading", { name: "外观" })).toBeVisible({ timeout: 15_000 });
      await expect(settingsDialog.getByRole("group", { name: "主题" })).toBeVisible();
      await shot(page, "A-1", "08-settings-appearance.png");
      await page.getByRole("button", { name: "关闭设置" }).click();
      await expect(settingsDialog).toHaveCount(0);

      /* ---- 附加捕获 2：暗色主题整窗 + 切回亮色对照（Titlebar 主题切换按钮） ---- */
      const toDark = page.getByRole("button", { name: "切换为深色主题" });
      await expect(toDark).toBeVisible();
      await toDark.click();
      await expect(page.getByRole("button", { name: "切换为浅色主题" })).toBeVisible({ timeout: 15_000 });
      await settleAnimation(page);
      await shot(page, "A-1", "09-theme-dark-window.png");
      const toLight = page.getByRole("button", { name: "切换为浅色主题" });
      await toLight.click();
      await expect(page.getByRole("button", { name: "切换为深色主题" })).toBeVisible({ timeout: 15_000 });
      await settleAnimation(page);
      await shot(page, "A-1", "10-theme-light-window.png");

      /* ---- 附加捕获 3：侧栏折叠态 / 展开态 ---- */
      await page.getByRole("button", { name: "收起侧栏" }).click();
      await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible({ timeout: 15_000 });
      await settleAnimation(page);
      await shot(page, "A-1", "11-sidebar-collapsed.png");
      await page.getByRole("button", { name: "展开侧栏" }).click();
      await expect(page.getByRole("button", { name: "收起侧栏" })).toBeVisible({ timeout: 15_000 });
      await settleAnimation(page);
      await shot(page, "A-1", "12-sidebar-expanded.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("A-2 Provider 失败修复：401 错误行可见且不泄露凭据 → 改回 fast 后重发成功", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A2-${Date.now().toString(36)}`;
    const tag = Date.now().toString(36);
    const failedMessage = `oc-e2e-验收-失败消息-A2-${tag}`;
    const fixedMessage = `oc-e2e-验收-修复后消息-A2-${tag}`;

    await lane.setStub({ mode: "error-401" });
    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      /* 401：错误行出现 + 退出流式态 + 凭据不回传 */
      await chat.fill(failedMessage);
      await chat.send();
      await expect(page.getByText("运行错误").first(), "401 应渲染运行错误事件行").toBeVisible({ timeout: 20_000 });
      await chat.expectIdle(15_000);
      await expect(page.getByText(lane.fakeApiKey), "凭据不得出现在 UI").toHaveCount(0);
      await shot(page, "A-2", "01-error-401-row.png");

      /* 修复：stub 改回 fast → 重发成功 */
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(fixedMessage);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);
      await shot(page, "A-2", "02-resend-success-after-fix.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("A-3 连续错误恢复：401/429/timeout 依次失败不卡死会话，最后 fast 成功", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A3-${Date.now().toString(36)}`;
    const tag = Date.now().toString(36);
    const messages = {
      unauthorized: `oc-e2e-验收-错Key消息-A3-${tag}`,
      rateLimited: `oc-e2e-验收-限流消息-A3-${tag}`,
      timeout: `oc-e2e-验收-超时消息-A3-${tag}`,
      recovered: `oc-e2e-验收-恢复消息-A3-${tag}`,
    };

    await lane.setStub({ mode: "error-401" });
    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);
      const errorRows = () => page.getByText("运行错误");

      /* 第 1 失败：401 */
      await chat.fill(messages.unauthorized);
      await chat.send();
      await expect(errorRows().first(), "401 应渲染运行错误事件行").toBeVisible({ timeout: 20_000 });
      await chat.expectIdle(15_000);
      await shot(page, "A-3", "01-error-401.png");

      /* 第 2 失败：429（SDK 可能重试，最终收敛） */
      await lane.setStub({ mode: "error-429" });
      await chat.fill(messages.rateLimited);
      await chat.send();
      await expect(errorRows().nth(1), "429 应追加运行错误事件行").toBeVisible({ timeout: 60_000 });
      await chat.expectIdle(15_000);
      await shot(page, "A-3", "02-error-429.png");

      /* 第 3 失败：timeout-reset（挂起后断开 socket） */
      await lane.setStub({ mode: "timeout-reset", delayMs: 2_500 });
      await chat.fill(messages.timeout);
      await chat.send();
      await expect(errorRows().nth(2), "超时应追加运行错误事件行").toBeVisible({ timeout: 30_000 });
      await chat.expectIdle(15_000);
      await shot(page, "A-3", "03-error-timeout.png");

      /* 三连失败后会话不被卡死：fast 成功 */
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(messages.recovered);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);
      await shot(page, "A-3", "04-recovered-fast-success.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("A-4 重启恢复：slow 流式中关闭应用 → 重启后流式态收敛 + 历史重建", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A4-${Date.now().toString(36)}`;
    const tag = Date.now().toString(36);
    const messageOne = `oc-e2e-验收-流式中重启消息-A4-${tag}`;
    const slowReply = `oc-e2e-验收-慢速回复（A4 重启恢复巡演）：这段文本跨越应用重启持续输出-${tag}`;

    // 慢速流：30 片 × 500ms ≈ 15s（保证重启发生在 turn 仍运行时）
    await lane.setStub({ mode: "slow", chunks: 30, intervalMs: 500, text: slowReply });

    let app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);
      await chat.fill(messageOne);
      await chat.send();
      await chat.expectStreaming(30_000);
      await shot(page, "A-4", "01-streaming-before-restart.png");

      /* 流式中关闭应用（后端继续运行，turn 不中断） */
      await closeApp(app);
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);

      const chat2 = new ChatPO(page2);
      await chat2.expectIdle(30_000);

      /* 等服务端 turn 完成（只读直连轮询，与 lane-a4b 第三例同范式） */
      const deadline = Date.now() + 60_000;
      let completed = false;
      while (Date.now() < deadline) {
        const sessions = await lane.apiGet<Array<{ id: string }>>("/api/sessions");
        if (sessions.length > 0) {
          const detail = await lane.apiGet<{ messages: string[] }>(`/api/sessions/${encodeURIComponent(sessions[0]!.id)}`);
          if (detail.messages.some((text) => text.includes(slowReply))) {
            completed = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(completed, "服务端 turn 应在应用重启后照常完成").toBe(true);

      /* 历史重建：草稿 → 切回会话，触发真实 detail 重建路径。
       * 注意：会话标题在 App.tsx 被截断为前 18 字符 + "…"，必须用短前缀定位侧栏行 */
      await page2.getByRole("button", { name: "新建会话" }).click();
      const chat3 = new ChatPO(page2);
      await chat3.openSession(messageOne.slice(0, 12));
      await chat3.expectMessageVisible(slowReply, 30_000);
      await shot(page2, "A-4", "02-history-rebuilt-after-restart.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("A-5 用量入口：一轮对话后 UsageBadge 可见 → 侧栏用量页含主对话来源记录", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A5-${Date.now().toString(36)}`;
    const message = `oc-e2e-验收-用量巡演消息-A5-${Date.now().toString(36)}`;

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      /* 一轮真实对话（fast） */
      await chat.fill(message);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      /* 会话头 UsageBadge（真实入口 1：会话头 chip） */
      const badge = page.locator(".usage-badge");
      await expect(badge).toBeVisible({ timeout: 20_000 });
      await expect(badge).toContainText("上下文");
      await shot(page, "A-5", "01-usage-badge-in-chat-head.png");

      /* 侧栏用量页（真实入口 2：侧栏底部「用量」，data-testid oc-sidebar-usage） */
      await page.getByTestId("oc-sidebar-usage").click();
      const usagePage = page.getByTestId("oc-usage-page");
      await expect(usagePage).toBeVisible({ timeout: 15_000 });
      await expect(usagePage.getByRole("heading", { name: "用量", exact: true })).toBeVisible();
      /* 主会话来源记录：按来源表应有「主对话」行 */
      await expect(page.getByTestId("oc-usage-source-row-main")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("oc-usage-total-card")).toBeVisible();
      await shot(page, "A-5", "02-usage-page-main-source.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("A-6 记忆页：档案页记忆区 + 真实写入置顶记忆 oc-e2e-验收记忆 + 记忆页只读视图", async ({ lane }) => {
    const agentName = `oc-e2e-验收助理-A6-${Date.now().toString(36)}`;
    const pinnedText = `oc-e2e-验收记忆-A6-${Date.now().toString(36)}`;

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const page = await firstWindow(app);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();
      await onboarding.completeAllSteps({
        name: agentName,
        apiKey: lane.fakeApiKey,
        baseUrl: lane.stubUrl,
        modelId: STUB_MODEL_ID,
      });
      await pinDefaultModelToStub(lane);
      await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });

      /* 入口：空态身份证卡点击进档案页（AgentIdCard aria-label） */
      await page.getByRole("button", { name: `打开 ${agentName} 的档案页` }).click();
      await expect(page.getByRole("heading", { name: "助理档案" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: /置顶记忆/ })).toBeVisible();
      await shot(page, "A-6", "01-profile-memory-area.png");

      /* 真实写入口：添加一条置顶记忆（ProfilePage pinned 写入链） */
      const pinnedInput = page.getByPlaceholder("添加一条置顶记忆…");
      await expect(pinnedInput).toBeVisible();
      await pinnedInput.fill(pinnedText);
      await page.getByRole("button", { name: "添加", exact: true }).click();
      await expect(page.getByText(pinnedText), "置顶记忆写入后应出现在列表").toBeVisible({ timeout: 15_000 });
      await shot(page, "A-6", "02-pinned-memory-added.png");

      /* 顶栏页签「记忆」→ 只读记忆视图（lane-a4d 同一入口）。
       * 断言真实加载完成锚点（l6-memory.ts LaneMemoryPO 同款元素）：
       * 「正在加载记忆…」消失 + 后台整理维护条出现稳定值（无运行 → 「空闲」），再截图 */
      await page.locator(".page-tabs").getByRole("button", { name: "记忆" }).click();
      await expect(page.getByText(`${agentName} 的只读记忆视图`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("正在加载记忆…")).toHaveCount(0, { timeout: 15_000 });
      const memory = new LaneMemoryPO(page);
      await expect(memory.maintenanceCard()).toBeVisible({ timeout: 15_000 });
      await expect(memory.maintenanceValue()).toHaveText("空闲", { timeout: 15_000 });
      await shot(page, "A-6", "03-memory-page-readonly-view.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });
});
