/**
 * B4 lane · 压缩摘要 Electron 真链（审计 §7.3 缺口 1/2）。
 *
 * 覆盖：
 * - live：真实 Electron 中发送 /compact → 服务端 pi session.compact()（摘要请求打本地
 *   stub，回复文本即摘要）→ session.compacting/compacted 事件 → live 压缩卡
 *   （completed 态：摘要正文 + tokens 前后）；
 * - 重启：重启应用（后端不动）→ 会话历史条目（type=compaction）重放为历史压缩卡，
 *   摘要正文一致；
 * - 真值：GET /api/sessions/:id 的 entries 含 compaction 条目。
 *
 * 压缩门槛：pi compaction keepRecentTokens 默认 20000、本地估算 4 字符/token——
 * 单条用户消息约 4.8 万字符（≈1.2 万 tokens）× 3 轮：从最新往回累计越过 20000 时
 * 切点落在第二轮起点，第一轮进入摘要区，避免 "Nothing to compact (session too small)"。
 * 摘要文本 ≤160 字符（CompactionCard 长摘要默认折叠，短摘要直接展示）且 ≤500
 * （服务端 sanitizeSensitiveText 截断）。
 */
import { expect, type ElectronApplication, type Page } from "@playwright/test";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import type { LaneB45BackendHarness } from "./fixtures/lane-b45/backend.js";
import { test } from "./fixtures/lane-b45/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
const SUMMARY = "oc-e2e-b45 压缩摘要：前段会话已归纳为三条要点，供后续轮次引用。";

/** 压缩门槛填充单元（约 22 字符 × 2200 ≈ 4.8 万字符/条） */
const FILLER_UNIT = "压缩门槛填充段落，用于抬高本地 token 估算值。";
const LONG_A = `长文A-${Date.now().toString(36)}：${FILLER_UNIT.repeat(2_200)}`;
const LONG_B = `长文B-${Date.now().toString(36)}：${FILLER_UNIT.repeat(2_200)}`;
const LONG_C = `长文C-${Date.now().toString(36)}：${FILLER_UNIT.repeat(2_200)}`;

/** 把全局默认模型固定到本地 stub（与 a4b 同法：模型确定性由 fixture 显式固定） */
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

test.describe("@b45 B4 压缩摘要 Electron 真链", () => {
  test("CMP-01: /compact 真链——live 压缩卡（completed，摘要+tokens）→ 重启后历史压缩卡一致", async ({ lane }) => {
    const agentName = `oc-e2e-助理-压缩-${Date.now().toString(36)}`;

    let app: ElectronApplication | null = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat } = await setupChat(lane, app, agentName);

      // 三轮长消息把 token 估算抬过 keepRecentTokens（20000）：前两轮在摘要区之外，
      // 第一轮进入摘要区（否则 Nothing to compact）
      for (const [prefix, body] of [["长文A", LONG_A], ["长文B", LONG_B], ["长文C", LONG_C]] as const) {
        await chat.fill(body);
        await chat.send();
        // expectIdle 已知盲区（#69）：等当轮用户气泡出现再进下一轮
        await chat.expectIdle(60_000);
        await chat.expectMessageVisible(prefix, 30_000);
      }
      await chat.expectDraftNoticeGone();

      // 服务端真值：会话已存在，取 id/title（重启后按 title 定位侧栏行）
      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const sessionId = sessions[0]!.id;
      const beforeDetail = await lane.apiGet<{ id: string; entries: Array<{ type?: string }> }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(beforeDetail.entries.some((entry) => entry.type === "compaction"), "压缩前不应有 compaction 条目").toBe(false);

      // 切 stub 摘要文本 → /compact 触发真实压缩（摘要请求打本地 stub）
      await lane.setStub({ mode: "text", text: SUMMARY });
      await chat.fill("/compact");
      await chat.send();

      // live 压缩卡：compacting → completed（标题、摘要正文、tokens 前后齐备）
      const compactingTitle = page.getByText("正在压缩会话上下文…");
      await expect(compactingTitle.or(page.getByText("上下文已压缩")).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("上下文已压缩")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("oc-compaction-summary")).toHaveText(SUMMARY, { timeout: 15_000 });
      await expect(page.getByTestId("oc-compaction-tokens")).toBeVisible();
      await expect(page.getByTestId("oc-compaction-tokens")).toContainText("约");

      // 服务端真值：entries 含 compaction 条目（pi JSONL 单一事实源的视图投影）
      const afterDetail = await lane.apiGet<{ entries: Array<{ type?: string }> }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(afterDetail.entries.some((entry) => entry.type === "compaction"), "压缩后应有 compaction 条目").toBe(true);

      // 重启（后端不动）→ 历史压缩卡：type=compaction 条目重放为 completed 卡，摘要一致
      await closeApp(app);
      app = null;
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);

      const afterRestart = await lane.apiGet<SessionListItem[]>(`/api/sessions`);
      const title = afterRestart.find((session) => session.id === sessionId)?.title ?? sessions[0]!.title;
      const chat2 = new ChatPO(page2);
      await chat2.openSession(title.slice(0, 12));

      await expect(page2.getByText("上下文已压缩")).toBeVisible({ timeout: 30_000 });
      await expect(page2.getByTestId("oc-compaction-summary")).toHaveText(SUMMARY);
      // tokens 前后值是 live 卡专有（历史条目视图不携带 tokens，TokensLine 缺值不渲染）
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
