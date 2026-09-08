/**
 * P1 审计 §8 人工验收巡演 · 波次 B（B-1 ~ B-6）视觉证据采集器（@acceptance）。
 *
 * lane-b45 fixture（mode=text / todo_tool stub，app 直连 Agent Server）。
 * 旅程编排照抄既有 lane 范式：B-1/2/3 ← lane-b3-branches（编辑重生成/重试/分支切换），
 * B-5 ← lane-b45-compaction（/compact live + 重启），B-6 ← lane-b45-todo（todo 卡 + 重启）。
 * 每张截图前先做可见性断言；UI 无对应入口时记 GAP，不改生产代码。
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import os from "node:os";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { REPO_ROOT } from "./fixtures/backend.js";
import type { LaneB45BackendHarness } from "./fixtures/lane-b45/backend.js";
import { test } from "./fixtures/lane-b45/harness.js";
import { BranchPO } from "./pages/branch-po.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
const REPLY = "oc-e2e-b45回复：验收巡演分支旅程的完整回复，用于视觉证据采集。";
const SUMMARY = "oc-e2e-b45 压缩摘要：前段会话已归纳为三条要点，供后续轮次引用。";

const TOUR_DIR = path.join(REPO_ROOT, "desktop", "test-artifacts", "acceptance-tour");

async function shot(page: Page, card: string, file: string): Promise<void> {
  await page.screenshot({ path: path.join(TOUR_DIR, card, file) });
}

/** 引导建助理 + 固定默认模型，返回会话页与分支 PO（与 lane-b3 setup 同法） */
async function setupChat(lane: LaneB45BackendHarness, app: ElectronApplication, agentName: string): Promise<{ page: Page; chat: ChatPO; branch: BranchPO }> {
  const page = await firstWindow(app);
  const onboarding = new OnboardingPO(page);
  await onboarding.expectStepAssistantVisible();
  await onboarding.completeAllSteps({
    name: agentName,
    apiKey: lane.fakeApiKey,
    baseUrl: lane.stubUrl,
    modelId: STUB_MODEL_ID,
  });
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length, "引导后应至少一个自定义 Provider").toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  await lane.apiSend("PUT", "/api/settings/preferences", {
    defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } },
  });
  const chat = new ChatPO(page);
  const branch = new BranchPO(page);
  await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
  return { page, chat, branch };
}

function expectIsolated(lane: LaneB45BackendHarness): void {
  expect(lane.homeDir.startsWith(os.tmpdir()), "OPENCOLORFUL_HOME 必须位于临时目录").toBe(true);
  expect(lane.userDataDir.startsWith(os.tmpdir()), "user-data-dir 必须位于临时目录").toBe(true);
}

interface SessionListItem {
  readonly id: string;
  readonly title: string;
}

interface BranchEntryView {
  readonly entryId: string;
  readonly type: string;
  readonly role?: string;
}

test.describe("@acceptance 验收巡演 · 波次 B（lane-b45）", () => {

  test("B-1+B-2+B-3 分支旅程：编辑重生成 → 重试 → 弹层切换来回", async ({ lane }) => {
    const tag = Date.now().toString(36);
    const agentName = `oc-e2e-验收助理-B123-${tag}`;
    const q1 = `oc-e2e-验收-原始第一问-B1-${tag}：请介绍分支的工作方式。`;
    const q2 = `oc-e2e-验收-改写后的问题-B1-${tag}：请用更简洁的方式介绍分支。`;

    await lane.setStub({ mode: "text", text: REPLY });
    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, branch } = await setupChat(lane, app, agentName);

      /* 基线一轮 */
      await chat.fill(q1);
      await chat.send();
      await chat.expectIdle(60_000);
      await chat.expectMessageVisible(REPLY, 30_000);
      await chat.expectDraftNoticeGone();
      await branch.expectBranchCount(1, 20_000);

      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]!.id;
      const entries1 = await lane.apiGet<{ entries: BranchEntryView[] }>(`/api/sessions/${sessionId}/entries`);
      const userEntry = entries1.entries.find((entry) => entry.role === "user");
      expect(userEntry, "应有第一轮用户条目可编辑").toBeTruthy();

      /* ---- B-1 编辑并重生成：行内编辑态截图 → 新分支成为当前 ---- */
      await page.getByTestId(`oc-message-edit-${userEntry!.entryId}`).click();
      const editor = page.getByTestId("oc-regenerate-editor");
      await expect(editor).toBeVisible();
      await shot(page, "B-1", "01-edit-mode.png");
      await editor.getByRole("textbox").fill(q2);
      await page.getByTestId("oc-regenerate-confirm").click();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(REPLY, 30_000);
      await expect(page.getByText(q2).first()).toBeVisible({ timeout: 20_000 });
      await branch.expectBranchItemCount(2, 20_000);
      await branch.expectBranchCount(2, 20_000);
      const treeAfterEdit = await lane.apiGet<{ branches: Array<{ isCurrent: boolean; leafPreview: string }> }>(`/api/sessions/${sessionId}/tree`);
      expect(treeAfterEdit.branches).toHaveLength(2);
      expect(treeAfterEdit.branches.filter((b) => b.isCurrent)).toHaveLength(1);
      expect(treeAfterEdit.branches.find((b) => b.isCurrent)?.leafPreview ?? "").toContain(REPLY.slice(0, 12));
      await shot(page, "B-1", "02-new-branch-current.png");

      /* ---- B-2 重试：助手结果重试 → 新兄弟分支 ---- */
      const entries2 = await lane.apiGet<{ entries: BranchEntryView[] }>(`/api/sessions/${sessionId}/entries`);
      const assistantEntry = entries2.entries.find((entry) => entry.role === "assistant");
      expect(assistantEntry, "应有助手条目可重试").toBeTruthy();
      await branch.retryMessage(assistantEntry!.entryId);
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(REPLY, 30_000);
      await expect(page.getByText(q2).first()).toBeVisible({ timeout: 20_000 });
      await branch.expectBranchItemCount(3, 20_000);
      await shot(page, "B-2", "01-retry-new-sibling-branch.png");

      /* ---- B-3 切换分支：弹层截图 → 切回原分支 → 再切回最新 ---- */
      const menu = await branch.openMenu();
      await expect(menu.locator('[data-testid^="oc-branch-item-"]')).toHaveCount(3);
      await shot(page, "B-3", "01-branch-menu.png");
      await branch.switchToBranch(0);
      await expect(page.getByText(q1).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(q2)).toHaveCount(0, { timeout: 20_000 });
      await shot(page, "B-3", "02-switched-to-original-branch.png");
      await branch.switchToBranch(2);
      await expect(page.getByText(q2).first()).toBeVisible({ timeout: 20_000 });
      await shot(page, "B-3", "03-switched-back-latest-branch.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("B-4 Fork：Fork 成新会话独立存在，源会话不改变", async ({ lane }) => {
    const tag = Date.now().toString(36);
    const agentName = `oc-e2e-验收助理-B4-${tag}`;
    const q1 = `oc-e2e-验收-fork源问题-B4-${tag}`;

    await lane.setStub({ mode: "text", text: REPLY });
    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, branch } = await setupChat(lane, app, agentName);

      await chat.fill(q1);
      await chat.send();
      await chat.expectIdle(60_000);
      await chat.expectMessageVisible(REPLY, 30_000);

      const sessionsBefore = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessionsBefore).toHaveLength(1);
      const sourceId = sessionsBefore[0]!.id;

      /* Fork → 自动导航到新会话（标题带 Fork 后缀） */
      await branch.fork();
      await expect(page.getByText("（Fork）").first()).toBeVisible({ timeout: 20_000 });
      await chat.expectMessageVisible(REPLY, 30_000);
      await shot(page, "B-4", "01-forked-new-session.png");

      const sessionsAfter = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessionsAfter).toHaveLength(2);
      const sourceTree = await lane.apiGet<{ branches: Array<{ isCurrent: boolean }> }>(`/api/sessions/${sourceId}/tree`);
      expect(sourceTree.branches).toHaveLength(1);

      /* 切回源会话：内容不变（问题与回复都在，标题不带 Fork） */
      const sourceRow = page.getByRole("button", { name: new RegExp(q1.slice(0, 16).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
        .filter({ hasNotText: "（Fork）" })
        .first();
      await expect(sourceRow).toBeVisible({ timeout: 20_000 });
      await sourceRow.click();
      await expect(page.getByText(q1).first()).toBeVisible({ timeout: 20_000 });
      await chat.expectMessageVisible(REPLY, 30_000);
      /* 主区不得出现 Fork 后缀（侧栏列表仍合法显示 Fork 会话行，不算源会话被改） */
      await expect(page.locator("main").getByText("（Fork）")).toHaveCount(0);
      await shot(page, "B-4", "02-source-session-unchanged.png");

      expectIsolated(lane);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("B-5 压缩摘要：超长会话 /compact → live 压缩卡 → 重启后历史压缩卡", async ({ lane }) => {
    const tag = Date.now().toString(36);
    const agentName = `oc-e2e-验收助理-B5-${tag}`;

    /** 压缩门槛填充单元（与 lane-b45-compaction 同法：≈4.8 万字符/条抬高 token 估算） */
    const FILLER_UNIT = "压缩门槛填充段落，用于抬高本地 token 估算值。";
    const longMessages = [
      [`长文A`, `长文A-${tag}：${FILLER_UNIT.repeat(2_200)}`],
      [`长文B`, `长文B-${tag}：${FILLER_UNIT.repeat(2_200)}`],
      [`长文C`, `长文C-${tag}：${FILLER_UNIT.repeat(2_200)}`],
    ] as const;

    await lane.setStub({ mode: "text", text: REPLY });
    let app: ElectronApplication | null = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      for (const [prefix, body] of longMessages) {
        await chat.fill(body);
        await chat.send();
        await chat.expectIdle(60_000);
        await chat.expectMessageVisible(prefix, 30_000);
      }
      await chat.expectDraftNoticeGone();

      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const title = sessions[0]!.title;

      /* /compact → live 压缩卡（completed 态：摘要正文 + tokens 前后） */
      await lane.setStub({ mode: "text", text: SUMMARY });
      await chat.fill("/compact");
      await chat.send();
      await expect(page.getByText("上下文已压缩")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("oc-compaction-summary")).toHaveText(SUMMARY, { timeout: 15_000 });
      await expect(page.getByTestId("oc-compaction-tokens")).toBeVisible();
      await expect(page.getByTestId("oc-compaction-tokens")).toContainText("约");
      /* 截图前把压缩卡滚入视口并做视口断言（toBeVisible 不保证在画面内） */
      const liveCard = page.locator(".compaction-card", { hasText: "上下文已压缩" }).last();
      await liveCard.scrollIntoViewIfNeeded();
      await expect(liveCard).toBeInViewport();
      await shot(page, "B-5", "01-live-compaction-card.png");

      /* 重启（后端不动）→ 历史压缩卡：摘要正文一致 */
      await closeApp(app);
      app = null;
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);
      const chat2 = new ChatPO(page2);
      await chat2.openSession(title.slice(0, 12));
      await expect(page2.getByText("上下文已压缩")).toBeVisible({ timeout: 30_000 });
      await expect(page2.getByTestId("oc-compaction-summary")).toHaveText(SUMMARY);
      /* 同法：历史压缩卡滚入视口再截图 */
      const historyCard = page2.locator(".compaction-card", { hasText: "上下文已压缩" }).last();
      await historyCard.scrollIntoViewIfNeeded();
      await expect(historyCard).toBeInViewport();
      await shot(page2, "B-5", "02-restart-compaction-card.png");

      expectIsolated(lane);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });

  test("B-6 Todo：真实 todo_write tool call 驱动 Todo 卡 → 重启后恢复一致", async ({ lane }) => {
    const tag = Date.now().toString(36);
    const agentName = `oc-e2e-验收助理-B6-${tag}`;
    const firstMessage = `oc-e2e-验收-待办首问-B6-${tag}：请记录本次工作的待办清单。`;

    const TODOS = [
      { content: "待办一：整理调研材料", status: "completed", priority: "high" },
      { content: "待办二：撰写章节初稿", status: "in_progress", priority: "medium", activeForm: "正在撰写章节初稿" },
      { content: "待办三：核对引用来源", status: "pending", priority: "low" },
    ] as const;

    await lane.setStub({ mode: "text", text: REPLY });
    let app: ElectronApplication | null = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      /* todo_tool 模式：第 1 次请求回流式 todo_write，第 2 次回文本收尾 */
      await lane.setStub({ mode: "todo_tool", todosJson: JSON.stringify({ todos: TODOS }) });
      await chat.fill(firstMessage);
      await chat.send();
      await chat.expectIdle(60_000);
      await chat.expectMessageVisible("待办清单已更新", 30_000);

      /* Live Todo 卡：计数 1/3 + 三条内容 */
      const card = page.getByTestId("oc-session-todo-card");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("oc-todo-counter")).toHaveText("1/3");
      await expect(card).toContainText("待办一：整理调研材料");
      await expect(card).toContainText("正在撰写章节初稿");
      await expect(card).toContainText("待办三：核对引用来源");
      await shot(page, "B-6", "01-live-todo-card.png");

      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const title = sessions[0]!.title;

      /* 重启恢复：SessionView.todos（SQLite durable）种子投影 → 卡片一致 */
      await closeApp(app);
      app = null;
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);
      const chat2 = new ChatPO(page2);
      await chat2.openSession(title.slice(0, 12));

      const card2 = page2.getByTestId("oc-session-todo-card");
      await expect(card2).toBeVisible({ timeout: 30_000 });
      await expect(page2.getByTestId("oc-todo-counter")).toHaveText("1/3");
      await expect(card2).toContainText("待办一：整理调研材料");
      await expect(card2).toContainText("正在撰写章节初稿");
      await expect(card2).toContainText("待办三：核对引用来源");
      await shot(page2, "B-6", "02-restart-todo-card.png");

      expectIsolated(lane);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
