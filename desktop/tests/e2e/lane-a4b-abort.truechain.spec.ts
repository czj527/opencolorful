/**
 * A4b lane · abort 竞态与迟到事件真链回归（@a4b）。
 *
 * 覆盖矩阵行（L6 竞态/迟到事件过滤视角；ABORT-01/02 的基础链已由 @smoke 与 L3 覆盖，不重复）：
 * - ABORT-01 竞态视角：临近完成时点停止——abort 与 turn 终态竞速，无论 abort 先到
 *   （cancelled 语义）还是后到（already-stopped/rejected 语义），UI 必须收敛空闲、
 *   可继续输入、服务端真值一致。
 * - ABORT-02 迟到事件视角：流式前段点停止——停止后 UI 保持收敛（不回流式、无「正在输入…」
 *   残留、正文不继续增长），立刻重发可收养新 stream。
 *
 * 注：发送按钮在本地乐观消息阶段即切换为「停止生成」（早于 202/streamId 登记），
 * 因此点击停止前必须先等正文片段可见，确保 abort 携带已登记的 streamId（与 @smoke 同法）。
 *
 * 真值断言（只读）：Node 侧直连 Agent Server 读 API 与 JSONL。
 */
import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import type { LaneBackendHarness } from "./fixtures/lane-a4b/backend.js";
import { test } from "./fixtures/lane-a4b/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
const FAST_REPLY = "oc-e2e-lane回复：A4b 真链回归的完整回复，用于验证定稿与持久化。";

async function pinDefaultModelToStub(lane: LaneBackendHarness): Promise<void> {
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length).toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  const response = await fetch(`${lane.serverUrl}/api/settings/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } } }),
  });
  expect(response.ok, `PUT preferences 应成功：${response.status}`).toBe(true);
}

async function setupChat(lane: LaneBackendHarness, agentName: string): Promise<{ app: ElectronApplication; page: Page; chat: ChatPO; agentId: string }> {
  const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
  const page = await firstWindow(app);
  const onboarding = new OnboardingPO(page);
  await onboarding.expectStepAssistantVisible();
  await onboarding.completeAllSteps({
    name: agentName,
    apiKey: lane.fakeApiKey,
    baseUrl: lane.stubUrl,
    modelId: STUB_MODEL_ID,
  });
  const agents = await lane.apiGet<Array<{ identity: { id: string } }>>("/api/agents");
  expect(agents).toHaveLength(1);
  await pinDefaultModelToStub(lane);
  const chat = new ChatPO(page);
  await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
  return { app, page, chat, agentId: agents[0]!.identity.id };
}

function readSessionJsonl(lane: LaneBackendHarness, agentId: string): string {
  const sessionsDir = path.join(lane.homeDir, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  let text = "";
  for (const name of fs.readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"))) {
    text += fs.readFileSync(path.join(sessionsDir, name), "utf8");
  }
  return text;
}

test.describe("@a4b abort lane", () => {

  test("ABORT-01 竞态视角: 临近完成点停止——UI 收敛空闲、可继续输入、服务端真值一致", async ({ lane }) => {
    const agentName = `oc-e2e-助理-abortrace-${Date.now().toString(36)}`;
    const messageBase = Date.now().toString(36);
    const messageOne = `oc-e2e-竞态首条消息-${messageBase}`;
    const raceReply = "oc-e2e-竞态回复：正文主体在这段文本里逐步推进，一直推进到接近结尾的位置，尾部还有最后一小段【尾声】。";
    // 前缀 = 去掉最后一小段（最后一到两个 chunk 才会送达的内容）
    const racePrefix = raceReply.replace("【尾声】。", "");
    const messageTwo = `oc-e2e-竞态后第二条消息-${messageBase}`;

    // 12 片 × 250ms = 3s：等前缀（≈11/12）可见后点停止，abort 与终态竞速
    await lane.setStub({ mode: "slow", chunks: 12, intervalMs: 250, text: raceReply });

    let app: ElectronApplication | null = null;
    try {
      const setup = await setupChat(lane, agentName);
      app = setup.app;
      const { chat, agentId } = setup;

      await chat.fill(messageOne);
      await chat.send();
      await setup.page.getByText(racePrefix).first().waitFor({ state: "visible", timeout: 15_000 });
      await chat.stop();

      // 竞速不变量（两个分支都应成立）：UI 收敛空闲、无残留流式标记、会话不被卡死
      await chat.expectIdle(15_000);
      await expect(chat.composer()).toBeEnabled();
      await expect(setup.page.getByText("正在输入…")).toHaveCount(0);

      // 竞速后会话仍可用：立刻重发一条，正常完成（fast 模式需显式重置 text，stub 只做 patch）
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(messageTwo);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      // 服务端真值：两轮用户消息 + 第二条完整回复落 JSONL，凭据不落
      const jsonl = readSessionJsonl(lane, agentId);
      expect(jsonl).toContain(messageOne);
      expect(jsonl).toContain(messageTwo);
      expect(jsonl).toContain(FAST_REPLY);
      expect(jsonl).not.toContain(lane.fakeApiKey);
    } finally {
      if (app !== null) await closeApp(app).catch(() => undefined);
    }
  });

  test("ABORT-02 迟到事件视角: 流式前段停止——迟到期 UI 保持收敛、立刻重发收养新 stream", async ({ lane }) => {
    const agentName = `oc-e2e-助理-abortlate-${Date.now().toString(36)}`;
    const messageBase = Date.now().toString(36);
    const messageOne = `oc-e2e-中止首条消息-${messageBase}`;
    const slowReply = "oc-e2e-慢速回复（中止场景）：这段文本将在流式中途被用户停止，后续内容不应再进入投影。";
    // 早期标记：出现在前几个 chunk（≈1s 内），确保停止时 202/streamId 已登记且流远未结束
    const earlyMarker = "（中止场景）";
    const messageTwo = `oc-e2e-中止后立刻重发的消息-${messageBase}`;

    // 慢速流：30 片 × 200ms ≈ 6s
    await lane.setStub({ mode: "slow", chunks: 30, intervalMs: 200, text: slowReply });

    let app: ElectronApplication | null = null;
    try {
      const setup = await setupChat(lane, agentName);
      app = setup.app;
      const { chat, agentId } = setup;

      await chat.fill(messageOne);
      await chat.send();
      await chat.expectStreaming();
      await setup.page.getByText(earlyMarker).first().waitFor({ state: "visible", timeout: 15_000 });
      await chat.stop();
      await chat.expectIdle(15_000);

      /* 迟到事件观察窗：停止后 4s 内 UI 必须保持收敛态——
       * 不回流式（无停止按钮）、无「正在输入…」残留、正文不增长为完整慢速回复
       * （中止后该 stream 不再推进；重放/在途旧 stream 事件不进入投影） */
      await expect(setup.page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0, { timeout: 4_000 });
      await expect(setup.page.getByText("正在输入…")).toHaveCount(0, { timeout: 4_000 });
      await expect(setup.page.getByText(slowReply)).toHaveCount(0, { timeout: 4_000 });

      // 立刻重发：新 prompt 收养新 streamId，正常完成（abort 后可继续输入；fast 显式重置 text）
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(messageTwo);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      // 服务端真值：JSONL 含两条用户消息与第二条完整回复
      const jsonl = readSessionJsonl(lane, agentId);
      expect(jsonl).toContain(messageOne);
      expect(jsonl).toContain(messageTwo);
      expect(jsonl).toContain(FAST_REPLY);
      expect(jsonl).not.toContain(lane.fakeApiKey);
    } finally {
      if (app !== null) await closeApp(app).catch(() => undefined);
    }
  });
});
