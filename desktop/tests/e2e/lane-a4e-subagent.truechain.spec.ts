/**
 * A4e lane · SUB-02 L6 Subagent 子代理真链回归（@a4e）。
 *
 * 核心链路（全波次唯一由 stub Provider 发出真实 openai-completions 流式 tool_calls 的 lane）：
 * 1. UI 引导建助理（自定义 Provider 指向 lane stub）→ 首条消息发送；
 * 2. stub 父会话首轮返回「分片流式 tool_calls delta」（spawn_subagent，arguments 显式
 *    model=<stub 模型>，§10.2 模型解析走 parent_request 路径）→ PI 解析并执行真实注册工具；
 * 3. Node 侧经 GET /api/observability/activity（eventName=subagent.thread.created，与
 *    ipc-source listSubagentThreads 同一发现机制）发现 threadId → 先订阅
 *    GET /api/subagents/threads/:id/stream（wire 级 SSE；先订阅后触发终态，回放语义兜底时序）；
 * 4. 子代理会话轮：stub 回 report_subagent_progress tool_call（transcript 出现 progress 消息）；
 *    次轮 report_subagent_result 被 lane 控制面「门」挡住 → Run 停在 running；
 * 5. Dock 列表出现新 thread（running 徽章）→ 进入详情：objective/Runs/消息可见，
 *    运行中态可见（与 GET transcript 真值一致）→ 控制面放行 → Run 终态 succeeded；
 * 6. 详情「刷新」→ 终态/resultSummary/消息·3 可见；关闭再打开 Dock → 列表卡片
 *    latestRunStatus=succeeded + resultSummary；tokens/tools/状态与 GET transcript 真值一致；
 * 7. 父会话次轮（tool 结果回来后）stub 纯文本收尾 → 聊天页可见助手回复。
 *
 * lane 内其余矩阵行的归属（不建用例，见任务报告）：
 * - SUB-01：L5 在 desktop/src/subagent.mock.test.tsx（A2 既有，不重写）；L3/L1 既有。
 *   本用例真链天然覆盖其「列表→详情」子集（不含错误态/空态——错误态属注入表职责）。
 * - SUB-03：L3 已 PASS；Desktop 设置页无 subagents 模型入口属 A7d，不建。
 * - SUB-04：SKIP（A8 缺口），不建。
 */
import { expect, type ElectronApplication } from "@playwright/test";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/lane-a4e/harness.js";
import { SubagentDockPO } from "./fixtures/lane-a4e/pages/subagent-dock.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const STUB_MODEL_ID = "oc-e2e-model-a";
const TASK_TITLE = "SUB-02 真链子代理任务";
const TASK_OBJECTIVE = "A4e 真链回归：读取任务简报，汇报一次进展，然后提交结构化结果。";
const PROGRESS_TEXT = "已完成简报解读，准备提交结果";
const RESULT_SUMMARY = "A4e 真链回归结果：已按简报完成并以结构化结果提交。";
const PARENT_FOLLOWUP_TEXT = "子代理已提交结果：A4e 真链回归任务收尾完成。";

/* ---- 只读真值 wire 形状（GET /api/subagents/threads/:id/transcript）---- */

interface TranscriptWire {
  readonly thread: { readonly threadId: string; readonly title: string; readonly status: string; readonly modelProviderId: string; readonly modelId: string };
  readonly taskBrief: { readonly title: string; readonly objective: string } | null;
  readonly runs: readonly {
    readonly runId: string;
    readonly status: string;
    readonly toolCallCount: number;
    readonly totalTokens: number;
    readonly result: { readonly summary: string } | null;
  }[];
  readonly messages: readonly {
    readonly messageId: string;
    readonly messageType: string;
    readonly sender: { readonly kind: string; readonly id: string };
    readonly parts: readonly { readonly kind: string; readonly text?: string }[];
  }[];
  readonly artifacts: readonly unknown[];
}

/** SSE 帧形状（模块级声明：函数签名与实现共同引用） */
interface StreamFrame {
  readonly seq: number;
  readonly event: string;
  readonly data: any;
}

/**
 * Node 侧对 `subagent:<threadId>` SSE 流（GET /api/subagents/threads/:id/stream）的只读订阅，
 * 收集 {seq, event, data} 帧。连接建立时服务端 getSince(threadId, 0) 全量重放已保留事件
 * + snapshot（回放兜底时序），随后实时跟随（§17.4 不重不漏）——因此先触发后发现 threadId
 * 再订阅，仍能拿到从 seq 1 起的完整事件序列（A4d collectMemoryAgentEventTypes 同模式）。
 */
async function collectSubagentStreamFrames(
  serverUrl: string,
  threadId: string,
  ownership: { readonly ownerAgentId: string; readonly parentSessionId: string },
  until: (frames: readonly StreamFrame[]) => boolean,
  timeoutMs = 60_000,
): Promise<readonly StreamFrame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${serverUrl}/api/subagents/threads/${encodeURIComponent(threadId)}/stream?ownerAgentId=${encodeURIComponent(ownership.ownerAgentId)}&parentSessionId=${encodeURIComponent(ownership.parentSessionId)}`;
  const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  if (!response.ok || response.body === null) {
    clearTimeout(timer);
    controller.abort();
    throw new Error(`subagent SSE 订阅失败：HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: StreamFrame[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = "";
        let id = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice("event: ".length).trim();
          else if (line.startsWith("id: ")) id = line.slice("id: ".length).trim();
          else if (line.startsWith("data: ")) data += line.slice("data: ".length);
        }
        if (eventName !== "") {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          frames.push({ seq: Number(id), event: eventName, data: parsed });
          if (until(frames)) return frames;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader.cancel().catch(() => undefined);
  }
}

test.describe("@a4e SUB-02 Subagent 子代理真链", () => {
  test("SUB-02: 流式 tool_calls spawn → dock 列表/详情/运行中/终态 → SSE 实时推进 → transcript 真值一致", async ({ lane }) => {
    const runTag = Date.now().toString(36);
    const agentName = `oc-e2e-子代理助理-${runTag}`;

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({ serverUrl: lane.appUrl, homeDir: lane.homeDir, userDataDir: lane.userDataDir });
      const page = await firstWindow(app);

      /* ---- 1. 引导建助理（Provider 指向 lane stub；默认模型确定性：引导后固定 stub 模型）---- */
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
      const stubModelId = provider.models[0]?.modelId ?? STUB_MODEL_ID;
      const pin = await lane.apiSend("PUT", "/api/settings/preferences", {
        defaults: { model: { providerId: provider.providerId, modelId: stubModelId } },
      });
      expect(pin.ok, `PUT preferences 应成功：HTTP ${pin.status}`).toBe(true);

      // stub 脚本参数对齐真实 providerId/modelId（spawn_subagent.arguments.model 显式携带，
      // 消除 delegation-policy §10.2 的解析歧义）并复位脚本状态
      await lane.configureScript({ providerId: provider.providerId, modelId: stubModelId });

      const chat = new ChatPO(page);
      await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });

      /* ---- 2. 发一条触发 spawn 的消息（stub 父会话首轮 → 流式 tool_calls spawn_subagent）---- */
      const triggerMessage = `oc-e2e-委派消息-${runTag}：请委派一个子代理执行 A4e 真链任务`;
      await chat.fill(triggerMessage);
      await chat.send();

      /* ---- 3. Node 侧真值发现 threadId（与 ipc-source 同一 activity 发现机制）---- */
      let sessionId: string | null = null;
      const sessionDeadline = Date.now() + 30_000;
      while (Date.now() < sessionDeadline && sessionId === null) {
        const sessions = await lane.apiGet<Array<{ id: string }>>("/api/sessions");
        sessionId = sessions[0]?.id ?? null;
        if (sessionId === null) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(sessionId, "发送后应创建父会话").not.toBeNull();
      // 归属参数（routes/subagents.ts §22.1）：ownerAgentId + parentSessionId 均必填且
      // 需通过 OWNER_ID_PATTERN；agentId 从会话详情真值解析（与会话同源，不靠猜测顺序）
      const sessionDetail = await lane.apiGet<{ id: string; agentId?: string }>(
        `/api/sessions/${encodeURIComponent(sessionId!)}`,
      );
      const ownerAgentId = sessionDetail.agentId
        ?? (await lane.apiGet<Array<{ id: string }>>("/api/agents"))[0]?.id
        ?? "";
      expect(ownerAgentId, "应能从会话详情或助理列表解析出 ownerAgentId").not.toBe("");
      const ownership = { ownerAgentId, parentSessionId: sessionId! };

      let threadId: string | null = null;
      const threadDeadline = Date.now() + 60_000;
      while (Date.now() < threadDeadline && threadId === null) {
        const activity = await lane.apiGet<{ items: Array<{ subagentThreadId?: string }> }>(
          `/api/observability/activity?eventName=subagent.thread.created&sessionId=${encodeURIComponent(sessionId!)}&limit=50`,
        );
        threadId = activity.items.find((row) => typeof row.subagentThreadId === "string")?.subagentThreadId ?? null;
        if (threadId === null) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(threadId, "60s 内应出现 subagent.thread.created（stub tool_call 已被 PI 解析并真实 spawn）").not.toBeNull();

      /* ---- 4. wire 级订阅 thread SSE（先订阅后触发终态；回放兜底时序）---- */
      // 子会话次轮（report_subagent_result）此刻仍被 stub 门挡住 → 终态尚未发生；
      // 先记录门状态作为「订阅先于终态」的证据，再收集直到 run 终态 + result 消息
      const stateBeforeSubscribe = await lane.stubState();
      expect(stateBeforeSubscribe.resultReleased, "订阅时结果门应尚未放行").toBe(false);
      expect(
        stateBeforeSubscribe.requests.some((row) => row.gated),
        "订阅时应已有被门挡住的子会话轮（report_subagent_result 等待放行）",
      ).toBe(true);

      const sseFramesPromise = collectSubagentStreamFrames(lane.serverUrl, threadId!, ownership, (frames) =>
        frames.some((frame) => frame.event === "run" && frame.data?.run?.status === "succeeded") &&
        frames.some((frame) => frame.event === "message" && frame.data?.message?.messageType === "result"),
      );
      sseFramesPromise.catch(() => undefined); // 防 unhandled rejection；真实失败由 await 处理

      /* ---- 5. Dock 列表：新 thread 出现（running 徽章 + stub 模型）→ 进入详情（运行中态可见）---- */
      const dock = new SubagentDockPO(page);
      await dock.open();
      const card = dock.card(TASK_TITLE);
      await expect(card, "Dock 列表应出现 spawn 出的新 thread 卡片").toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText("open");
      await expect(card).toContainText(stubModelId);
      // 运行中：latestRunStatus 徽章为 running（stub 门挡住结果 → Run 真实处于 running）
      await expect(card).toContainText("running");

      await dock.openCard(TASK_TITLE);
      await expect(dock.detailTitle()).toHaveText(TASK_TITLE, { timeout: 15_000 });
      await expect(dock.objective()).toHaveText(TASK_OBJECTIVE);
      await expect(dock.runBadges().first()).toHaveText("running", { timeout: 15_000 });

      // 运行中真值对照（只读）：GET transcript 应同为 running + task/progress 两条消息
      const runningTruth = await lane.apiGet<TranscriptWire>(
        `/api/subagents/threads/${encodeURIComponent(threadId!)}/transcript?ownerAgentId=${encodeURIComponent(ownership.ownerAgentId)}&parentSessionId=${encodeURIComponent(ownership.parentSessionId)}`,
      );
      expect(runningTruth.runs[0]?.status, "运行中 run 状态真值").toBe("running");
      expect(runningTruth.messages.map((message) => message.messageType), "运行中 transcript 消息类型真值").toEqual(["task", "progress"]);
      await expect(dock.sectionHeading("消息 · 2")).toBeVisible();

      /* ---- 6. 控制面放行 → Run 终态；先等真值终态，再点「刷新」看 UI 收敛 ---- */
      await lane.releaseChild();
      let truth: TranscriptWire | null = null;
      const terminalDeadline = Date.now() + 60_000;
      while (Date.now() < terminalDeadline) {
        const current = await lane.apiGet<TranscriptWire>(
          `/api/subagents/threads/${encodeURIComponent(threadId!)}/transcript?ownerAgentId=${encodeURIComponent(ownership.ownerAgentId)}&parentSessionId=${encodeURIComponent(ownership.parentSessionId)}`,
        );
        const status = current.runs[0]?.status;
        if (status !== null && status !== undefined && status !== "queued" && status !== "starting" && status !== "running") {
          truth = current;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(truth?.runs[0]?.status, "放行后 Run 应真实终态 succeeded").toBe("succeeded");
      const finalRun = truth!.runs[0]!;
      expect(finalRun.result?.summary ?? null, "结构化结果 summary 真值").toBe(RESULT_SUMMARY);
      expect(finalRun.totalTokens, "usage 应从 stub wire 帧流入 Run（tokens > 0）").toBeGreaterThan(0);

      // 详情「刷新」（icon-btn）：唯一的手动更新入口 → 终态/结果/消息·3 可见
      await dock.refreshDetail();
      await expect(dock.runBadges().first()).toHaveText("succeeded", { timeout: 15_000 });
      await expect(dock.sectionHeading("Runs · 1")).toBeVisible();
      await expect(dock.dockPanel().locator(".subagent-run")).toContainText(`tools ${finalRun.toolCallCount}`);
      await expect(dock.dockPanel().locator(".subagent-run")).toContainText(`tokens ${finalRun.totalTokens}`);
      await expect(dock.dockPanel().locator(".subagent-run-summary")).toHaveText(RESULT_SUMMARY);
      await expect(dock.sectionHeading("消息 · 3")).toBeVisible();
      const messageRows = dock.messageRows();
      await expect(messageRows).toHaveCount(3);
      // task（parent_agent → subagent，data parts）/ progress（subagent 文本）/ result（data part）
      await expect(messageRows.nth(0).locator(".subagent-msg-sender")).toContainText("parent_agent:");
      await expect(messageRows.nth(0).locator(".badge")).toHaveText("task");
      await expect(messageRows.nth(1).locator(".subagent-msg-sender")).toContainText("subagent:");
      await expect(messageRows.nth(1).locator(".badge")).toHaveText("progress");
      await expect(messageRows.nth(1).locator(".subagent-msg-text")).toHaveText(PROGRESS_TEXT);
      await expect(messageRows.nth(2).locator(".badge")).toHaveText("result");
      await expect(dock.sectionHeading("Artifacts · 0")).toBeVisible();
      await expect(dock.dockPanel().getByText("暂无 Artifact")).toBeVisible();

      /* ---- 7. 返回列表 → 关闭再打开 Dock（重挂载触发 listSubagentThreads 重载）→ 终态卡片 ---- */
      await dock.backToList();
      await dock.close();
      await dock.open();
      const freshCard = dock.card(TASK_TITLE);
      await expect(freshCard).toBeVisible({ timeout: 30_000 });
      await expect(freshCard).toContainText("succeeded");
      await expect(freshCard).toContainText(RESULT_SUMMARY);

      /* ---- 8. 父会话次轮收尾：tool 结果回来后 stub 纯文本 → 聊天页助手回复可见 ---- */
      await chat.expectMessageVisible(PARENT_FOLLOWUP_TEXT, 30_000);

      /* ---- 9. wire 级证据：SSE 事件序列（snapshot → message(progress) → run(succeeded) → message(result)）---- */
      const frames = await sseFramesPromise;
      const seqs = frames.map((frame) => frame.seq);
      expect(seqs.length, "SSE 应收到 ≥4 帧").toBeGreaterThanOrEqual(4);
      expect(
        seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!),
        `SSE seq 应严格递增（不重不漏）：${JSON.stringify(seqs)}`,
      ).toBe(true);
      expect(frames[0]!.event, "SSE 首帧应为 snapshot（cursor=0 初始状态）").toBe("snapshot");
      const kinds = frames.map((frame) => frame.event);
      expect(kinds, "SSE 应包含 message/run 面板流事件").toContain("message");
      expect(kinds).toContain("run");
      const progressFrame = frames.find((frame) => frame.event === "message" && frame.data?.message?.messageType === "progress");
      const runFrame = frames.find((frame) => frame.event === "run" && frame.data?.run?.status === "succeeded");
      const resultFrame = frames.find((frame) => frame.event === "message" && frame.data?.message?.messageType === "result");
      expect(progressFrame, "SSE 应推送 progress 消息事件").toBeTruthy();
      expect(runFrame, "SSE 应推送 succeeded Run 终态事件").toBeTruthy();
      expect(resultFrame, "SSE 应推送 result 消息事件").toBeTruthy();
      expect(
        progressFrame!.seq < runFrame!.seq && runFrame!.seq < resultFrame!.seq,
        `SSE 顺序应为 progress → run 终态 → result：${JSON.stringify(seqs)}`,
      ).toBe(true);
      // 终态 run 事件载荷与真值一致（同一 SQLite 记录）
      expect(runFrame!.data?.run?.runId).toBe(finalRun.runId);
      expect(runFrame!.data?.run?.totalTokens).toBe(finalRun.totalTokens);

      /* ---- 10. stub 请求分类日志（wire 级脚本证据：父首轮 spawn → 子轮 → 父次轮收尾）---- */
      const stubState = await lane.stubState();
      expect(stubState.spawnSent, "stub 应已发出 spawn_subagent 流式 tool_calls").toBe(true);
      expect(stubState.resultSent, "stub 应已放行并发出 report_subagent_result").toBe(true);
      expect(stubState.requests[0]?.kind, "首个模型请求应为父会话首轮（spawn）").toBe("parent-first");
      expect(stubState.requests.map((row) => row.kind)).toContain("child-first");
      expect(stubState.requests.map((row) => row.kind)).toContain("child-followup");

      /* ---- 11. 终态真值对照（只读，UI=API 同源核对）---- */
      expect(truth!.thread.title).toBe(TASK_TITLE);
      expect(truth!.thread.status).toBe("open");
      expect(truth!.thread.modelProviderId).toBe(provider.providerId);
      expect(truth!.thread.modelId).toBe(stubModelId);
      expect(truth!.taskBrief?.objective ?? null).toBe(TASK_OBJECTIVE);
      expect(
        truth!.messages.map((message) => message.messageType),
        "终态 transcript 消息类型真值",
      ).toEqual(["task", "progress", "result"]);
      expect(truth!.artifacts.length).toBe(0);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
