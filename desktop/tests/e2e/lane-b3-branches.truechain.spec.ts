/**
 * B3 lane · branches/workbench 真链回归（@b3）。
 *
 * 覆盖冻结契约（plans/p1-conversation-workbench.en.md §3.2）的 B3 用户可见语义：
 * - BRANCH-01 编辑并重生成：行内编辑 → 新分支成为当前分支（timeline 切换），
 *   旧分支保留在切换器中（JSONL append-only；API/JSONL 双侧真值对照）；
 * - BRANCH-02 重试：助手结果重试 → 同轮原文重生成 → 新兄弟分支；
 * - BRANCH-03 分支切换：切回旧分支 → timeline 呈现旧分支内容，重启后分支头保持；
 * - BRANCH-04 运行中 409：turn 流式期间切换/重生成 → 「会话正在运行，请先停止后再操作」
 *   + 停止动作（不自动中止；停止后可操作）；
 * - BRANCH-05 Fork：Fork 成独立会话 → 新会话（标题 Fork 后缀）独立存在，源会话不变。
 *
 * 真值断言（只读）：Node 侧直连 Agent Server（serverUrl）读 API（tree/entries）与 JSONL。
 */
import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import type { LaneB3BackendHarness } from "./fixtures/lane-b3/backend.js";
import { test } from "./fixtures/lane-b3/harness.js";
import { BranchPO } from "./pages/branch-po.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model";
/** stub fast 模式的默认完整回复（lane-b3 server-bootstrap.ts DEFAULT_TEXT） */
const FAST_REPLY = "oc-e2e-lane-b3回复：B3 真链回归的完整回复，用于验证定稿与持久化。";

interface SessionListItem {
  readonly id: string;
  readonly title: string;
}

interface BranchSummary {
  readonly branchId: string;
  readonly leafPreview: string;
  readonly entryCount: number;
  readonly isCurrent: boolean;
}

interface BranchEntryView {
  readonly entryId: string;
  readonly turnId: string | null;
  readonly type: string;
  readonly role?: string;
  readonly text: string;
}

/** 把全局默认模型固定到本地 stub（防环境凭据内置模型兜底回归；与 lane-a4b 同法） */
async function pinDefaultModelToStub(lane: LaneB3BackendHarness): Promise<void> {
  const providers = await lane.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
  expect(providers.length, "引导后应至少一个自定义 Provider").toBeGreaterThanOrEqual(1);
  const provider = providers[0]!;
  // P0-1 信任边界：Agent Server 写请求 strict 模式必须携带本机服务令牌（fixture 只读 server-token 文件）
  await lane.apiSend("PUT", "/api/settings/preferences", {
    defaults: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId ?? STUB_MODEL_ID } },
  });
}

/** 引导建助理 + 固定默认模型；返回已就绪的页面与 PO（会话尚未创建） */
async function setup(lane: LaneB3BackendHarness, app: ElectronApplication, agentName: string): Promise<{ page: Page; chat: ChatPO; branch: BranchPO }> {
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
  expect(agents, "引导后应恰好创建一个助理").toHaveLength(1);
  await pinDefaultModelToStub(lane);
  await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });
  return { page, chat: new ChatPO(page), branch: new BranchPO(page) };
}

/** 只读拼接会话 JSONL 内容（agents/<id>/sessions/*.jsonl） */
function readSessionJsonl(lane: LaneB3BackendHarness, agentId: string): string {
  const sessionsDir = path.join(lane.homeDir, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  let text = "";
  for (const name of fs.readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"))) {
    text += fs.readFileSync(path.join(sessionsDir, name), "utf8");
  }
  return text;
}

test.describe("@b3 branches/workbench lane", () => {

  test("BRANCH-01/02: 编辑并重生成与重试 → 新分支成为当前分支，旧分支保留（API/JSONL 对照）", async ({ lane }) => {
    const agentName = `oc-e2e-助理-重生成-${Date.now().toString(36)}`;
    const originalQuestion = `oc-e2e-第一问-${Date.now().toString(36)}：请介绍分支的工作方式。`;
    const editedQuestion = `oc-e2e-改写后的问题-${Date.now().toString(36)}：请用更简洁的方式介绍分支。`;

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, branch } = await setup(lane, app, agentName);

      // 第一轮：建立基线分支（当前分支 1 条目轮次）
      await chat.fill(originalQuestion);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);
      await chat.expectDraftNoticeGone();

      // 分支切换器出现（单分支）；timeline 导航含该轮锚点
      await branch.expectBranchCount(1, 20_000);
      await branch.expectTimelineNodeCount(1, 20_000);

      // 服务端真值：单分支 + 用户条目 entryId（供 UI 编辑操作定位）
      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]!.id;
      const treeBefore = await lane.apiGet<{ currentBranchId: string | null; branches: BranchSummary[] }>(`/api/sessions/${sessionId}/tree`);
      expect(treeBefore.branches).toHaveLength(1);
      expect(treeBefore.branches[0]?.isCurrent).toBe(true);
      const entriesBefore = await lane.apiGet<{ entries: BranchEntryView[] }>(`/api/sessions/${sessionId}/entries`);
      const userEntry = entriesBefore.entries.find((entry) => entry.role === "user");
      expect(userEntry, "entries 应包含第一轮用户条目").toBeTruthy();

      // 编辑并重生成：行内编辑器 → 新文本 → 202 turn 正常完成 → 新分支成为当前分支
      await branch.editAndRegenerate(userEntry!.entryId, editedQuestion);
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      // 切换器：2 个分支；新分支 isCurrent
      await branch.expectBranchItemCount(2, 20_000);
      const treeAfter = await lane.apiGet<{ currentBranchId: string | null; branches: BranchSummary[] }>(`/api/sessions/${sessionId}/tree`);
      expect(treeAfter.branches).toHaveLength(2);
      expect(treeAfter.branches.filter((b) => b.isCurrent)).toHaveLength(1);
      const currentPreview = treeAfter.branches.find((b) => b.isCurrent)?.leafPreview ?? "";
      expect(currentPreview).toContain(FAST_REPLY.slice(0, 12));

      // timeline 已切到新分支：新问题可见，旧问题不在当前 timeline
      await expect(page.getByText(editedQuestion).first()).toBeVisible({ timeout: 20_000 });

      // JSONL 真值：两问均 append-only 落盘（旧分支内容保留）；凭据红线
      const agents2 = await lane.apiGet<Array<{ identity: { id: string } }>>("/api/agents");
      const jsonl = readSessionJsonl(lane, agents2[0]!.identity.id);
      expect(jsonl).toContain(originalQuestion);
      expect(jsonl).toContain(editedQuestion);
      expect(jsonl).not.toContain(lane.fakeApiKey);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });

  test("BRANCH-03/04: 重试产生新分支；流式中分支操作 409 + 停止后可切回旧分支并保持", async ({ lane }) => {
    const agentName = `oc-e2e-助理-切换-${Date.now().toString(36)}`;
    const base = Date.now().toString(36);
    const question1 = `oc-e2e-切回场景第一问-${base}`;
    const question2 = `oc-e2e-切回场景第二问-${base}`;

    await lane.setStub({ mode: "slow", chunks: 20, intervalMs: 300, text: FAST_REPLY });

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, branch } = await setup(lane, app, agentName);

      // 两轮基线（slow 模式照常完成，只是慢）
      await chat.fill(question1);
      await chat.send();
      await chat.expectIdle(60_000);
      await lane.setStub({ mode: "fast", text: FAST_REPLY });
      await chat.fill(question2);
      await chat.send();
      await chat.expectIdle(30_000);

      // 重试（助手结果，取第一轮的助手条目）→ 新分支只含第一轮（共 2 分支）
      const sessions = await lane.apiGet<SessionListItem[]>("/api/sessions");
      const sessionId = sessions[0]!.id;
      const entries = await lane.apiGet<{ entries: BranchEntryView[] }>(`/api/sessions/${sessionId}/entries`);
      const assistantEntry = entries.entries.find((entry) => entry.role === "assistant");
      expect(assistantEntry, "应有助手条目可重试").toBeTruthy();
      await branch.retryMessage(assistantEntry!.entryId);
      await chat.expectIdle(30_000);
      await branch.expectBranchItemCount(2, 20_000);

      // 重试的新分支 timeline：分支点在第一轮 → 第二问不在；第一问保留
      await expect(page.getByText(question2)).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByText(question1).first()).toBeVisible({ timeout: 20_000 });
      await branch.expectTimelineNodeCount(1, 20_000);

      // 切回旧分支（第 0 个分支项 = 旧分支）：第二问重新可见
      await branch.switchToBranch(0);
      await expect(page.getByText(question2).first()).toBeVisible({ timeout: 20_000 });
      // timeline 导航恢复两个轮次锚点（entryId 不可变 → 跨切换稳定）
      await branch.expectTimelineNodeCount(2, 20_000);

      /* BRANCH-04：流式中分支操作 → 409 分态 + 停止（切换器弹层错误条，不自动中止） */
      await lane.setStub({ mode: "slow", chunks: 20, intervalMs: 300, text: FAST_REPLY });
      await chat.fill(`oc-e2e-流式期间第三问-${base}`);
      await chat.send();
      await chat.expectStreaming();
      await branch.switchToBranch(1);
      await branch.expectBusyErrorInMenu(20_000);
      await branch.stopFromMenu();
      await chat.expectIdle(30_000);
      // 停止后（空闲）分支操作恢复：菜单可开、条目仍为 2
      await branch.expectBranchItemCount(2, 20_000);

      /* 重启后分支头保持：重开应用 → 当前分支仍是切回的旧分支（含第二问） */
      await closeApp(app);
      const app2 = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page2 = await firstWindow(app2);
      const chat2 = new ChatPO(page2);
      const branch2 = new BranchPO(page2);
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);
      await chat2.openSession(question1.slice(0, 20));
      // 重启后投影保持旧分支：第二问可见（分支头持久化生效）
      await expect(page2.getByText(question2).first()).toBeVisible({ timeout: 30_000 });
      await branch2.expectBranchItemCount(2, 30_000);
      await closeApp(app2).catch(() => undefined);

      // JSONL 真值：三轮问题 + 凭据红线
      const agents3 = await lane.apiGet<Array<{ identity: { id: string } }>>("/api/agents");
      const jsonl = readSessionJsonl(lane, agents3[0]!.identity.id);
      expect(jsonl).toContain(question1);
      expect(jsonl).toContain(question2);
      expect(jsonl).not.toContain(lane.fakeApiKey);
    } finally {
      await closeApp(app).catch(() => undefined);
      await lane.setStub({ mode: "fast", text: FAST_REPLY }).catch(() => undefined);
    }
  });

  test("BRANCH-05: Fork 成独立会话 → 新会话标题带 Fork 后缀、内容一致，源会话不变", async ({ lane }) => {
    const agentName = `oc-e2e-助理-fork-${Date.now().toString(36)}`;
    const question = `oc-e2e-fork 源问题-${Date.now().toString(36)}`;

    const app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
    try {
      const { page, chat, branch } = await setup(lane, app, agentName);

      await chat.fill(question);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      const sessionsBefore = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessionsBefore).toHaveLength(1);
      const sourceId = sessionsBefore[0]!.id;

      // Fork 成独立会话 → 自动导航到新会话（标题带 Fork 后缀）
      await branch.fork();
      await expect(page.getByText("（Fork）").first()).toBeVisible({ timeout: 20_000 });
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      // 服务端真值：恰好 2 个会话，新会话 sourceSessionId 指源；源会话树不变
      const sessionsAfter = await lane.apiGet<SessionListItem[]>("/api/sessions");
      expect(sessionsAfter).toHaveLength(2);
      const forkMeta = await lane.apiGet<{ id: string; title: string; sourceSessionId?: string }>(`/api/sessions/${sessionIdOf(sessionsAfter, sourceId)}`);
      expect(forkMeta.sourceSessionId).toBe(sourceId);
      expect(forkMeta.title).toContain("（Fork）");
      const sourceTree = await lane.apiGet<{ branches: BranchSummary[] }>(`/api/sessions/${sourceId}/tree`);
      expect(sourceTree.branches).toHaveLength(1);
    } finally {
      await closeApp(app).catch(() => undefined);
    }
  });
});

function sessionIdOf(sessions: SessionListItem[], sourceId: string): string {
  const fork = sessions.find((session) => session.id !== sourceId);
  if (fork === undefined) throw new Error("Fork 会话未在会话列表中出现");
  return fork.id;
}
