/**
 * A4b lane · chat/stream/recovery 真链回归（@a4b）。
 *
 * 覆盖矩阵行：
 * - CHAT-05：IPC 断线时发送——明确 offline 中文错误、不静默、请求不发出（仅 L6 可验）。
 *   断线注入方式 = lane fixture 的 circuit proxy（断开 app→server 转发，等效网络断线），
 *   不 kill Agent Server 进程（desktop-test-conventions §五.5：普通 lane 不注入进程失败）。
 * - CHAT-06：Provider 错误渲染（错 Key 401 / 限流 429 / 超时近似）——运行错误可见、
 *   退出流式态、可继续输入、凭据不回传（UI 与 JSONL 双侧断言）。
 * - 恢复语义：流式中重启应用 → 流式态收敛 + 会话历史重建 + 重启后继续对话。
 *
 * 真值断言（只读）：Node 侧直连 Agent Server（serverUrl，不经断路代理）读 API 与 JSONL。
 */
import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import type { LaneBackendHarness } from "./fixtures/lane-a4b/backend.js";
import { test } from "./fixtures/lane-a4b/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
/** stub fast 模式的默认完整回复（server-bootstrap.ts DEFAULT_TEXT） */
const FAST_REPLY = "oc-e2e-lane回复：A4b 真链回归的完整回复，用于验证定稿与持久化。";

interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly agentId: string | null;
  readonly archived: boolean;
}

/** 把全局默认模型固定到本地 stub（防环境凭据内置模型兜底回归；与冒烟同法） */
async function pinDefaultModelToStub(lane: LaneBackendHarness): Promise<void> {
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length, "引导后应至少一个自定义 Provider").toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  const response = await fetch(`${lane.serverUrl}/api/settings/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } } }),
  });
  expect(response.ok, `PUT preferences 应成功：${response.status}`).toBe(true);
}

/** 引导建助理 + 固定默认模型，返回会话页 PO */
async function setupChat(lane: LaneBackendHarness, app: ElectronApplication, agentName: string): Promise<{ page: Page; chat: ChatPO; agentId: string }> {
  const page = await firstWindow(app);
  const onboarding = new OnboardingPO(page);
  await onboarding.expectStepAssistantVisible();
  await onboarding.completeAllSteps({
    name: agentName,
    apiKey: lane.fakeApiKey,
    baseUrl: lane.stubUrl,
    modelId: STUB_MODEL_ID,
  });

  const agents = await lane.apiGet<Array<{ identity: { id: string; name: string } }>>("/api/agents");
  expect(agents, "引导后应恰好创建一个助理").toHaveLength(1);
  await pinDefaultModelToStub(lane);

  const chat = new ChatPO(page);
  await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
  return { page, chat, agentId: agents[0]!.identity.id };
}

/** 只读拼接会话 JSONL 内容（agents/<id>/sessions/*.jsonl） */
function readSessionJsonl(lane: LaneBackendHarness, agentId: string): string {
  const sessionsDir = path.join(lane.homeDir, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  let text = "";
  for (const name of fs.readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"))) {
    text += fs.readFileSync(path.join(sessionsDir, name), "utf8");
  }
  return text;
}

test.describe("@a4b chat/stream/recovery lane", () => {

  test("CHAT-05: IPC 断线时发送——明确 offline 中文错误、请求不发出，恢复后可继续发送", async ({ lane }) => {
    const agentName = `oc-e2e-助理-offline-${Date.now().toString(36)}`;
    const blockedMessage = `oc-e2e-断线期消息：不应到达服务端-${Date.now().toString(36)}`;
    const recoveredMessage = `oc-e2e-恢复后消息：断线恢复后发送成功-${Date.now().toString(36)}`;

    let app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      // 连接态锚点：Titlebar 显示已连接（health 巡检通过）
      await expect(page.getByText(/已连接 · 127\.0\.0\.1:\d+/)).toBeVisible({ timeout: 20_000 });

      // 断开 app → server 转发（等效网络断线；不 kill 服务进程）
      await lane.circuit(true);
      await expect(
        page.getByText(/离线 · 127\.0\.0\.1:\d+（自动重连中）/),
        "health 巡检失败后 Titlebar 应转离线",
      ).toBeVisible({ timeout: 25_000 });

      // 断线期发送：明确 offline 中文错误，不静默
      await chat.fill(blockedMessage);
      await chat.send();
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 15_000 });
      await expect(alert).toContainText("连接已断开，请检查本地服务是否运行，恢复后会自动重连。");
      // 请求不发出（快路径守卫）：草稿保留在输入框，未被清空
      await expect(chat.composer()).toHaveValue(blockedMessage);

      // 服务端真值：无任何会话被创建
      const sessionsDuringOffline = await lane.apiGet<SessionView[]>("/api/sessions");
      expect(sessionsDuringOffline, "断线期发送不应创建会话").toHaveLength(0);

      // 恢复转发 → 自动重连（health 巡检回绿）→ 草稿保留已断言，发送新消息验证恢复
      await lane.circuit(false);
      await expect(page.getByText(/已连接 · 127\.0\.0\.1:\d+/)).toBeVisible({ timeout: 30_000 });
      await chat.fill(recoveredMessage);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectDraftNoticeGone();
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      // 服务端真值：恰好一个会话，JSONL 只含恢复后的消息（断线期那条从未到达）
      const sessions = await lane.apiGet<SessionView[]>("/api/sessions");
      expect(sessions, "恢复后应恰好一个活跃会话").toHaveLength(1);
      const agents = await lane.apiGet<Array<{ identity: { id: string } }>>("/api/agents");
      const jsonl = readSessionJsonl(lane, agents[0]!.identity.id);
      expect(jsonl).toContain(recoveredMessage);
      expect(jsonl, "断线期消息不应落入 JSONL").not.toContain(blockedMessage);
      // 红线：凭据不落 JSONL
      expect(jsonl).not.toContain(lane.fakeApiKey);

      // 隔离自检
      expect(lane.homeDir.startsWith(os.tmpdir()), "OPENCOLORFUL_HOME 必须位于临时目录").toBe(true);
      expect(lane.userDataDir.startsWith(os.tmpdir()), "user-data-dir 必须位于临时目录").toBe(true);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("CHAT-06: Provider 错误渲染（错 Key/限流/超时）——运行错误可见、退出流式态、凭据不回传", async ({ lane }) => {
    const agentName = `oc-e2e-助理-错误渲染-${Date.now().toString(36)}`;
    const messageBase = Date.now().toString(36);
    const okMessage = `oc-e2e-成功消息-${messageBase}`;
    const messages = {
      unauthorized: `oc-e2e-错Key消息-${messageBase}`,
      rateLimited: `oc-e2e-限流消息-${messageBase}`,
      timeout: `oc-e2e-超时消息-${messageBase}`,
    };

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, agentId } = await setupChat(lane, app, agentName);

      // 基线：fast 模式成功一轮（确认链路本身可用）
      await chat.fill(okMessage);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      const errorRows = () => page.getByText("运行错误");

      /* 错 Key（401）：错误行出现 + 退出流式态 + 凭据不回传 */
      await lane.setStub({ mode: "error-401" });
      await chat.fill(messages.unauthorized);
      await chat.send();
      await expect(errorRows().first(), "401 应渲染运行错误事件行").toBeVisible({ timeout: 20_000 });
      await chat.expectIdle(15_000);
      await expect(page.getByText(lane.fakeApiKey), "凭据不得出现在 UI").toHaveCount(0);

      /* 限流（429）：追加运行错误行；限流若被 SDK 重试，最终仍须终态收敛 */
      await lane.setStub({ mode: "error-429" });
      await chat.fill(messages.rateLimited);
      await chat.send();
      await expect(errorRows().nth(1), "429 应追加运行错误事件行").toBeVisible({ timeout: 60_000 });
      await chat.expectIdle(15_000);

      /* 超时近似（stub 挂起后断开 socket）：追加运行错误行并收敛 */
      await lane.setStub({ mode: "timeout-reset", delayMs: 2_500 });
      await chat.fill(messages.timeout);
      await chat.send();
      await expect(errorRows().nth(2), "超时应追加运行错误事件行").toBeVisible({ timeout: 30_000 });
      await chat.expectIdle(15_000);

      // 三次失败后仍可继续对话（会话不被错误卡死；fast 显式重置 text）
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(`oc-e2e-错误后恢复消息-${messageBase}`);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      /* 服务端真值：JSONL 双侧对照 + 凭据红线 */
      const jsonl = readSessionJsonl(lane, agentId);
      expect(jsonl).toContain(okMessage);
      expect(jsonl).not.toContain(lane.fakeApiKey);
      const authJsonPath = path.join(lane.homeDir, "auth", "auth.json");
      if (fs.existsSync(authJsonPath)) {
        expect(fs.readFileSync(authJsonPath, "utf8"), "API Key 应只存入 AuthStorage").toContain(lane.fakeApiKey);
      }
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("恢复语义: 流式中重启应用——流式态收敛、会话历史重建、重启后可继续对话", async ({ lane }) => {
    const agentName = `oc-e2e-助理-重启恢复-${Date.now().toString(36)}`;
    const messageBase = Date.now().toString(36);
    const messageOne = `oc-e2e-流式中重启消息-${messageBase}`;
    const slowReply = `oc-e2e-慢速回复（流式中重启场景）：这段文本跨越应用重启持续输出，用于验证恢复语义。-${messageBase}`;
    const messageTwo = `oc-e2e-重启后第二条消息-${messageBase}`;

    // 慢速流：30 片 × 500ms ≈ 15s（保证首次重启发生在 turn 仍运行时）
    await lane.setStub({ mode: "slow", chunks: 30, intervalMs: 500, text: slowReply });

    let app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { chat, agentId } = await setupChat(lane, app, agentName);
      await chat.fill(messageOne);
      await chat.send();
      await chat.expectStreaming();

      // 流式中关闭应用（后端继续运行，turn 不中断）
      await closeApp(app);
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);

      // 不再自动进入引导（ONB-02 锚点）
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);

      const chat2 = new ChatPO(page2);
      // 流式态收敛：重启后 UI 不停留在流式态（发送可用、无停止按钮）
      await chat2.expectIdle(30_000);

      // 等待服务端 turn 完成（只读直连；turn 不受应用重启影响）
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
      expect(completed, "服务端 turn 应在应用重启后照常完成（JSONL 含完整回复）").toBe(true);

      // 重启后历史重建：在途 turn 完成不会自动刷新已打开的时间线（已知限制 #7 同族），
      // 经「草稿 → 切回会话」触发一次真实 detail 重建路径，断言完整回复出现
      await page2.getByRole("button", { name: "新建会话" }).click();
      const chat3 = new ChatPO(page2);
      await chat3.openSession(messageOne);
      await chat3.expectMessageVisible(slowReply, 30_000);

      // 重启后可继续对话（fast 模式需显式重置 text，stub 只做 patch）
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat2.fill(messageTwo);
      await chat2.send();
      await chat2.expectIdle(30_000);
      await chat2.expectMessageVisible(FAST_REPLY, 30_000);

      // 服务端真值：两轮消息 + 完整回复均落 JSONL
      const jsonl = readSessionJsonl(lane, agentId);
      expect(jsonl).toContain(messageOne);
      expect(jsonl).toContain(slowReply);
      expect(jsonl).toContain(messageTwo);
      expect(jsonl).not.toContain(lane.fakeApiKey);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });
});
