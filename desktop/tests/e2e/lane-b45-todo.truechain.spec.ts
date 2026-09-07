/**
 * B5 lane · durable session todo Electron 真链（审计 §7.3 缺口 3/4）。
 *
 * 覆盖：
 * - 工具驱动：stub 流式 tool_calls(todo_write)（arguments 分片增量）→ PI 经 customTools
 *   通道执行 todo_write → SessionTodoStore.replace（单事务）→ todo.updated 事件 →
 *   Desktop SessionTodoCard（计数 1/3 + 三条内容可见）；
 * - 重启恢复：重启应用（后端不动）→ 打开会话 → SessionView.todos（SQLite 真值）
 *   种子投影 → 卡片与计数一致。
 *
 * 注：audit 原文"断线 Replay"以重启路径覆盖（重启=重新订阅+快照种子；todo.updated
 * 的 Replay Store 断线补发语义已由 B5 后端/Store/Replay 单测覆盖），Electron 侧
 * 不重复 a4b 的 circuit proxy 断线场景——偏差记录于 lane 实施记录。
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import type { LaneB45BackendHarness } from "./fixtures/lane-b45/backend.js";
import { test } from "./fixtures/lane-b45/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";

const TODOS = [
  { content: "待办一：整理调研材料", status: "completed", priority: "high" },
  { content: "待办二：撰写章节初稿", status: "in_progress", priority: "medium", activeForm: "正在撰写章节初稿" },
  { content: "待办三：核对引用来源", status: "pending", priority: "low" },
] as const;

/** 把全局默认模型固定到本地 stub（与 a4b 同法） */
async function pinDefaultModelToStub(lane: LaneB45BackendHarness): Promise<void> {
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length).toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  const pin = await lane.apiSend("PUT", "/api/settings/preferences", {
    defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } },
  });
  expect(pin !== undefined, "PUT preferences 应成功（失败即抛错）").toBe(true);
}

/** 引导建助理 + 固定默认模型，返回会话页 PO（与 a4b setupChat 同法） */
async function setupChat(lane: LaneB45BackendHarness, app: ElectronApplication, agentName: string): Promise<{ page: Page; chat: ChatPO }> {
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

interface SessionListItem {
  readonly id: string;
  readonly title: string;
}

test.describe("@b45 B5 durable todo Electron 真链", () => {
  test("TODO-01: 真实 todo_write tool call 驱动 Todo 卡（1/3）→ 重启后 SessionView.todos 恢复一致", async ({ lane }) => {
    const agentName = `oc-e2e-助理-待办-${Date.now().toString(36)}`;
    const firstMessage = `oc-e2e-首问-${Date.now().toString(36)}：请记录本次工作的待办清单。`;

    let app: ElectronApplication | null = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      // stub 切 todo_tool 模式：第 1 次模型请求回流式 todo_write tool_calls，
      // PI 执行工具（SessionTodoStore.replace → todo.updated）后第 2 次请求回文本收尾
      await lane.setStub({ mode: "todo_tool", todosJson: JSON.stringify({ todos: TODOS }) });

      await chat.fill(firstMessage);
      await chat.send();
      await chat.expectIdle(60_000);
      await chat.expectMessageVisible("待办清单已更新", 30_000);

      // Live Todo 卡：计数 1/3（completed 1 条；in_progress/pending 不计入完成）。
      // in_progress 项渲染 activeForm（「当前进行：…」）而非 content，故分别断言。
      const card = page.getByTestId("oc-session-todo-card");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("oc-todo-counter")).toHaveText("1/3");
      await expect(card).toContainText("待办一：整理调研材料");
      await expect(card).toContainText("正在撰写章节初稿");
      await expect(card).toContainText("待办三：核对引用来源");

      // 服务端真值：SessionView.todos = SQLite session_todos 的三条，状态一致
      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const sessionId = sessions[0]!.id;
      const detail = await lane.apiGet<{ id: string; todos: Array<{ content: string; status: string; priority: string }> }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(detail.todos).toHaveLength(TODOS.length);
      expect(detail.todos.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending"]);
      expect(detail.todos.map((todo) => todo.priority)).toEqual(["high", "medium", "low"]);

      // 重启恢复：SessionView.todos 种子 → 卡片与计数一致（SQLite durable，非内存态）
      await closeApp(app);
      app = null;
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);

      const title = sessions[0]!.title;
      const chat2 = new ChatPO(page2);
      await chat2.openSession(title.slice(0, 12));

      const card2 = page2.getByTestId("oc-session-todo-card");
      await expect(card2).toBeVisible({ timeout: 30_000 });
      await expect(page2.getByTestId("oc-todo-counter")).toHaveText("1/3");
      await expect(card2).toContainText("待办一：整理调研材料");
      await expect(card2).toContainText("正在撰写章节初稿");
      await expect(card2).toContainText("待办三：核对引用来源");
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
