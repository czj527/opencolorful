/**
 * L5 · CHAT-04（无已配置凭据模型时发送被拦）+ SSE 固定回放序列冒烟。
 * CHAT-04 注入"全部 Provider 未配置凭据"状态（Mock fixture 注入表：empty/error 域），
 * 断言中文错误 +「去配置 Provider」入口；回放用 fixtures/sse 固定 Envelope 序列驱动 projector。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import { CorrelatedError, type ErrorCorrelation } from "./errors.js";
import type { ActivityLogRow } from "./mock-data.js";
import {
  applyEvent,
  applyLocalUserMessage,
  createProjector,
  markPromptSent,
  snapshotOf,
  type ChatSnapshot,
  type LiveEnvelope,
} from "./data/projector.js";
import type { Thread } from "./mock-data.js";
import type { DesktopDataSource, ActivityFilter, SessionUsageView } from "./data/source.js";
import { renderApp } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { replayChatSource } from "../tests/fixtures/replay-chat-source.js";
import { replayAssistantText, replaySequence, replayUserMessage } from "../tests/fixtures/sse/replay-sequence.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";
import { makeChathomePO } from "../tests/fixtures/pages/chathome.js";

const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

/* ---------------------------------------------------------------------------
 * lane A4b 本地回放工具（仅本文件使用，不改共享 fixture）：
 * - fixedEnvelope：与 tests/fixtures/sse/replay-sequence.ts 同形状的 Envelope 工厂
 *   （streamId 固定、sequence 严格递增，满足协议契约的确定性回放底座）。
 * - stepwiseReplaySource：把 sendPrompt 后的事件按批次（真实定时器）依次投影，
 *   使「流式中 → 定稿」的 flush 快照可断言（合批窗口内中间帧仍不可断言，
 *   遵守矩阵 CHAT-03 风险注记，只断言批次边界上的 flush 快照）。
 * ------------------------------------------------------------------------- */

const LANE_STREAM_ID = "st-lane-a4b-replay";

function makeEnvelopeFactory() {
  let sequence = 0;
  return (type: string, payload: unknown): LiveEnvelope => {
    sequence += 1;
    return {
      eventId: `ev-lane-a4b-${sequence}`,
      streamId: LANE_STREAM_ID,
      sequence,
      timestamp: "2026-09-01T10:00:00+08:00",
      type,
      payload,
    };
  };
}

interface ReplayBatch {
  readonly atMs: number;
  /** 该批次应用前登记 streamId（模拟 202 响应到达的 markPromptSent 时机） */
  readonly mark?: boolean;
  readonly events: readonly LiveEnvelope[];
}

function stepwiseReplaySource(
  base: DesktopDataSource,
  options: {
    readonly threadId: string;
    readonly userMessage: string;
    readonly batches: readonly ReplayBatch[];
  },
): DesktopDataSource {
  const projector = createProjector("原");
  const handlers = new Set<(snapshot: ChatSnapshot) => void>();
  let played = false;
  const timers: number[] = [];
  const notify = () => {
    const snapshot = snapshotOf(projector);
    for (const handler of handlers) handler(snapshot);
  };
  return overrideSource(base, {
    createThread: async (): Promise<Thread> => ({
      id: options.threadId,
      title: options.userMessage.slice(0, 18),
      preview: "",
      time: "",
      status: "active",
      agentId: "yuan",
    }),
    subscribeChat: (sessionId: string, handler: (snapshot: ChatSnapshot) => void) => {
      if (sessionId !== options.threadId) return base.subscribeChat(sessionId, handler);
      handlers.add(handler);
      handler(snapshotOf(projector));
      return () => {
        handlers.delete(handler);
      };
    },
    sendPrompt: (sessionId: string, content: string) => {
      if (sessionId !== options.threadId || content !== options.userMessage || played) {
        return base.sendPrompt(sessionId, content);
      }
      played = true;
      // 发送即本地乐观用户消息 + 等待态（与 ipc-source.sendPrompt 同序）
      applyLocalUserMessage(projector, content);
      notify();
      for (const batch of options.batches) {
        timers.push(window.setTimeout(() => {
          if (batch.mark) markPromptSent(projector, LANE_STREAM_ID);
          for (const envelope of batch.events) applyEvent(projector, envelope);
          notify();
        }, batch.atMs));
      }
      return Promise.resolve();
    },
  });
}

it("CHAT-04: 无已配置凭据模型时发送被拦——中文错误 +「去配置 Provider」入口按钮", async () => {
  const base = new MockDataSource();
  const createThreadSpy = vi.fn(base.createThread.bind(base));
  const sendPromptSpy = vi.fn(base.sendPrompt.bind(base));
  const source = overrideSource(base, {
    listProviders: () =>
      base.listProviders().then((providers) => providers.map((provider) => ({ ...provider, credentialConfigured: false }))),
    listModels: () =>
      base.listModels().then((models) => models.map((model) => ({ ...model, credentialConfigured: false }))),
    createThread: (agentId, title, options) => {
      void createThreadSpy(agentId, title, options);
      return base.createThread(agentId, title, options);
    },
    sendPrompt: (sessionId, content) => {
      void sendPromptSpy(sessionId, content);
      return base.sendPrompt(sessionId, content);
    },
  });
  injected.current = source;
  const app = await renderApp();
  try {
    // 无已配置凭据 → 首启检测派生 first-run，先经「稍后再说」退出引导
    await screen.findByRole("heading", { name: "给你的助理起个名字" });
    await app.user.click(screen.getByRole("button", { name: "稍后再说" }));

    await makeSidebarPO(app.user).newThread();

    // 空态配置入口 + 模型 chip 显示「未配置模型」（等 listModels 注入态加载完成）
    await screen.findByRole("button", { name: "还没有可用模型，去配置 Provider 与 API Key →" });
    expect(makeChathomePO(app.user).noModelEntry()).not.toBeNull();
    const composer = makeComposerPO(app.user);
    expect(composer.noModelChip()).not.toBeNull();

    // 发送被拦：errors.ts 将「未配置模型」映射为中文文案 + 设置动作按钮
    await composer.type("这条消息不应发出");
    await composer.pressEnter();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("还没有可用模型，请先在设置中配置 Provider 与 API Key。");

    // 下一步动作按钮打开设置 → 模型与 Provider 类目
    await app.user.click(within(alert).getByRole("button", { name: "去设置 → 模型与 Provider" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByRole("heading", { name: "模型与 Provider" })).toBeTruthy();

    // 请求不发出
    expect(createThreadSpy).not.toHaveBeenCalled();
    expect(sendPromptSpy).not.toHaveBeenCalled();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("SSE 固定回放序列: 经同一 projector 定稿为 用户/思考/助手 投影（CHAT-03 类断言的确定性底座）", async () => {
  const base = new MockDataSource();
  injected.current = replayChatSource(base, {
    content: replayUserMessage,
    sequence: replaySequence,
    threadId: "replay-session-1",
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(replayUserMessage);
    await composer.pressEnter();

    // 回放定稿：助手正文、思考行收敛为「思考完成」、用量 meta
    await screen.findByText(replayAssistantText);
    // 用户消息出现 3 处：侧栏会话行 + 会话头标题 + 时间线正文（标题由首条消息派生）
    expect(screen.getAllByText(replayUserMessage).length).toBe(3);
    await waitFor(() => {
      expect(screen.getByText("思考完成")).toBeTruthy();
    });
    expect(screen.getByText("15 tokens")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("CHAT-06: Provider 错误渲染（错 Key 401）——role=alert 中文错误 + 设置动作按钮，不回传凭据", async () => {
  const base = new MockDataSource();
  const fakeKey = "sk-oc-e2e-leaky-key";
  let sendCalls = 0;
  const source = overrideSource(base, {
    sendPrompt: (sessionId, content) => {
      sendCalls += 1;
      // 仅首次失败（模拟真实链路：POST /messages 202 后 Provider 返回 401）；
      // 错误文本故意携带 Key 片段，验证 UI 映射层不把英文原文/凭据透出
      if (sendCalls === 1) {
        return Promise.reject(new Error(`HTTP 401 Unauthorized: invalid api key ${fakeKey}`));
      }
      return base.sendPrompt(sessionId, content);
    },
  });
  injected.current = source;
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type("这条消息会遇到错 Key");
    await composer.pressEnter();

    // 中文错误 + 下一步动作按钮（errors.ts isAuth 分支）
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("API Key 可能已失效或权限不足，无法完成请求。");
    // 凭据不回传/不回显：alert 与整页都不出现 Key 片段
    expect(alert.textContent).not.toContain(fakeKey);
    expect(screen.queryByText(new RegExp(fakeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull();
    // 不把英文原文透出
    expect(alert.textContent).not.toContain("Unauthorized");

    // 下一步动作：打开设置 → 模型与 Provider
    await app.user.click(within(alert).getByRole("button", { name: "去设置 → 模型与 Provider" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByRole("heading", { name: "模型与 Provider" })).toBeTruthy();

    // 错误后 composer 不卡死：关闭设置重发 → mock 正常流式回复
    await app.user.keyboard("{Escape}");
    await composer.type("重发一次");
    await composer.pressEnter();
    await screen.findByText("收到。我会把执行细节留在事件层：思考、工具调用和文件变更都以摘要呈现，你可以随时展开检查，普通回复保持连续可读。", undefined, { timeout: 5_000 });
    expect(sendCalls).toBe(2);
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("CHAT-06: Provider 错误渲染（限流 429 / 超时 ETIMEDOUT）——中文兜底文案、不透出英文原文", async () => {
  const base = new MockDataSource();
  const cases: readonly { readonly name: string; readonly cause: Error; readonly expectText: string }[] = [
    { name: "429", cause: new Error("HTTP 429 Too Many Requests: rate limit exceeded"), expectText: "消息发送失败，请重试。" },
    { name: "timeout", cause: new Error("ETIMEDOUT"), expectText: "连接已断开，请检查本地服务是否运行，恢复后会自动重连。" },
  ];
  for (const item of cases) {
    const source = overrideSource(new MockDataSource(), {
      sendPrompt: () => Promise.reject(item.cause),
    });
    injected.current = source;
    const app = await renderApp();
    try {
      await makeSidebarPO(app.user).newThread();
      const composer = makeComposerPO(app.user);
      await composer.type(`这条消息会遇到 ${item.name} 错误`);
      await composer.pressEnter();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, `${item.name} 应映射为中文文案`).toContain(item.expectText);
      // 英文原文/堆栈不透出；rate limit 也不透出
      expect(alert.textContent).not.toContain("429");
      expect(alert.textContent).not.toContain("ETIMEDOUT");
      expect(alert.textContent).not.toContain("rate limit");
      // 兜底文案无下一步动作按钮（429/断连分支现状：仅中文提示）
      expect(alert.querySelector("button")).toBeNull();
    } finally {
      app.unmount();
      app.consoleTracker.restore();
      injected.current = null;
    }
    app.consoleTracker.expectNoErrors();
  }
});

it("CHAT-03: L5 回放底座（分批 flush）——token 增量推进 → 流式态可见 → 定稿光标消失与用量收敛", async () => {
  const base = new MockDataSource();
  const envelope = makeEnvelopeFactory();
  const userMessage = "分批回放：观察流式态与定稿收敛";
  const partial = "分批回放的前半句正在生成，";
  const full = "分批回放的前半句正在生成，后半句到达后定稿。";
  injected.current = stepwiseReplaySource(base, {
    threadId: "lane-a4b-stepwise",
    userMessage,
    batches: [
      {
        atMs: 60,
        mark: true,
        events: [
          envelope("turn.started", { turnId: "turn-lane-a4b-1" }),
          envelope("thinking.delta", { delta: "分批回放：先推进增量，再观察定稿。" }),
          envelope("message.started", { role: "assistant" }),
          envelope("message.delta", { role: "assistant", delta: partial }),
        ],
      },
      {
        atMs: 600,
        events: [
          envelope("message.delta", { role: "assistant", delta: "后半句到达后定稿。" }),
          envelope("message.completed", { role: "assistant", content: full }),
          envelope("turn.completed", { turnId: "turn-lane-a4b-1", usage: { input: 12, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 24 } }),
        ],
      },
    ],
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(userMessage);
    await composer.pressEnter();

    // 第 1 批 flush：流式态可见（停止生成按钮 + 正在输入 meta + 部分正文）
    const stopButton = await screen.findByRole("button", { name: "停止生成" });
    expect(stopButton).toBeTruthy();
    await screen.findByText(partial);
    expect(screen.getByText("正在输入…")).toBeTruthy();

    // 第 2 批 flush：定稿——光标态消失、正文补全、思考收敛、用量 meta 出现
    await screen.findByText(full, undefined, { timeout: 5_000 });
    await waitFor(() => {
      expect(screen.queryAllByText("正在输入…")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
    });
    expect(screen.getByText("24 tokens")).toBeTruthy();
    expect(screen.getByText("思考完成")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("CHAT-03: L5 回放底座（事件行）——工具/计划/记忆事件行渲染、展开收起与完成态摘要", async () => {
  const base = new MockDataSource();
  const envelope = makeEnvelopeFactory();
  const userMessage = "事件行回放：工具计划记忆展开收起";
  const assistantText = "事件行回放完成：工具、计划与记忆均已投影。";
  injected.current = replayChatSource(base, {
    content: userMessage,
    threadId: "lane-a4b-event-rows",
    sequence: [
      envelope("turn.started", { turnId: "turn-lane-a4b-2" }),
      envelope("tool.started", { toolCallId: "tc-lane-1", toolName: "read_file" }),
      envelope("tool.delta", { delta: "oc-e2e-目标文件.md" }),
      envelope("tool.completed", { toolCallId: "tc-lane-1", result: "文件内容摘要（脱敏样本）", isError: false }),
      envelope("plan.updated", { items: ["梳理矩阵行", "补齐回归证据"] }),
      envelope("memory.recall.completed", { recallId: "rc-lane-1", resultCount: 2, layer: "long" }),
      envelope("message.started", { role: "assistant" }),
      envelope("message.delta", { role: "assistant", delta: assistantText }),
      envelope("message.completed", { role: "assistant", content: assistantText }),
      envelope("turn.completed", { turnId: "turn-lane-a4b-2", usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18 } }),
    ],
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(userMessage);
    await composer.pressEnter();

    // 定稿
    await screen.findByText(assistantText, undefined, { timeout: 5_000 });

    /* 工具事件行：完成态摘要 + 展开/收起 */
    const toolRow = screen.getByRole("button", { name: /工具调用/ });
    expect(within(toolRow).getByText("1 个工具已完成")).toBeTruthy();
    expect(within(toolRow).getByText("完成")).toBeTruthy();
    await app.user.click(toolRow);
    expect(toolRow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("oc-e2e-目标文件.md")).toBeTruthy();
    await app.user.click(toolRow);
    expect(toolRow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("oc-e2e-目标文件.md")).toBeNull();

    /* 计划事件行：排队态摘要 + 展开 */
    const planRow = screen.getByRole("button", { name: /工作计划/ });
    expect(within(planRow).getByText("2 项")).toBeTruthy();
    await app.user.click(planRow);
    expect(screen.getByText("梳理矩阵行")).toBeTruthy();
    expect(screen.getByText("补齐回归证据")).toBeTruthy();

    /* 记忆事件行：命中摘要 + 来源 meta */
    const memoryRow = screen.getByRole("button", { name: /记忆回想/ });
    expect(within(memoryRow).getByText("命中 2 条相关记忆")).toBeTruthy();
    expect(within(memoryRow).getByText("search_memory · long")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

/* ---------------------------------------------------------------------------
 * A4f lane（USAGE-01 / SEC-04）：
 * - USAGE-01 复用本文件 stepwiseReplaySource（分批 flush 让 App 壳的 streaming
 *   布尔产生 true→false 翻转，turn.completed 触发 getSessionUsage 刷新链；
 *   一次性回放源在同一个 notify 里收敛，App 壳观测不到翻转，不适用）；
 *   getSessionUsage 按「同一 sessionId 的调用序」脚本化：第 1 次 = 会话头初始
 *   加载，第 2 次 = 轮后刷新，返回更大 usage 值。
 * - SEC-04 用桌面 mock 首会话（desktop）自带的审批事件行（mock-data e6），
 *   断言 EventRow 本地审批状态机（现行产品语义：本地 state，无协议回传——
 *   矩阵 SEC-04 风险注记一致）。
 * ------------------------------------------------------------------------- */

it("USAGE-01: 会话头 UsageBadge 渲染（tokens/turns/context%）+ 一轮结束后刷新链更新 badge", async () => {
  const base = new MockDataSource();
  const usageInitial: SessionUsageView = { totalTokens: 39200, turns: 6, contextTokens: 38400, contextWindow: 128000, contextPercent: 30 };
  const usageAfterTurn: SessionUsageView = { totalTokens: 41200, turns: 7, contextTokens: 40100, contextWindow: 128000, contextPercent: 31 };
  const usageCalls = new Map<string, number>();
  const envelope = makeEnvelopeFactory();
  const userMessage = "用量刷新回放：观察 badge 初始值与轮后刷新";
  const partial = "用量刷新回放的前半句，";
  const full = "用量刷新回放的前半句，后半句到达后定稿。";
  injected.current = overrideSource(stepwiseReplaySource(base, {
    threadId: "lane-a4f-usage",
    userMessage,
    batches: [
      {
        atMs: 60,
        mark: true,
        events: [
          envelope("turn.started", { turnId: "turn-lane-a4f-usage" }),
          envelope("thinking.delta", { delta: "用量刷新回放：先推进增量。" }),
          envelope("message.started", { role: "assistant" }),
          envelope("message.delta", { role: "assistant", delta: partial }),
        ],
      },
      {
        atMs: 600,
        events: [
          envelope("message.delta", { role: "assistant", delta: "后半句到达后定稿。" }),
          envelope("message.completed", { role: "assistant", content: full }),
          envelope("turn.completed", { turnId: "turn-lane-a4f-usage", usage: { input: 12, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 24 } }),
        ],
      },
    ],
  }), {
    getSessionUsage: (sessionId: string) => {
      const calls = (usageCalls.get(sessionId) ?? 0) + 1;
      usageCalls.set(sessionId, calls);
      return Promise.resolve(calls >= 2 ? usageAfterTurn : usageInitial);
    },
  });
  const app = await renderApp();
  try {
    // 初始渲染：桌面 mock 首会话 badge 与 mock 值一致（chip 文本 + title 提示）
    const desktopBadge = await screen.findByText("上下文 38.4k/128k · 30%");
    expect(desktopBadge.getAttribute("title")).toBe("本会话总用量 39200 tokens · 6 轮");

    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(userMessage);
    await composer.pressEnter();

    // 新会话初始加载（该 sessionId 第 1 次调用）→ badge 以初始值出现
    const badge = await screen.findByText("上下文 38.4k/128k · 30%", undefined, { timeout: 5_000 });
    expect(badge.getAttribute("title")).toBe("本会话总用量 39200 tokens · 6 轮");

    // turn 完成 → streaming false 翻转 → 刷新链（第 2 次调用）→ badge 更新为更大值
    await screen.findByText(full, undefined, { timeout: 5_000 });
    const refreshed = await screen.findByText("上下文 40.1k/128k · 31%", undefined, { timeout: 5_000 });
    expect(refreshed.getAttribute("title")).toBe("本会话总用量 41200 tokens · 7 轮");
    expect(usageCalls.get("lane-a4f-usage")).toBe(2);
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("SEC-04: 聊天内审批「允许一次」→ 状态机切 approved（按钮消失 + 已允许反馈）", async () => {
  injected.current = new MockDataSource();
  const app = await renderApp();
  try {
    // 桌面 mock 首会话（desktop）自带审批事件行（mock-data e6：工作区写入）
    await screen.findByText("需要确认");
    expect(screen.getByText("等待你的决定")).toBeTruthy();
    expect(screen.getByText(/工作区写入 · D:\\PI-study\\opencolorful/)).toBeTruthy();

    await app.user.click(screen.getByRole("button", { name: "允许一次" }));

    const result = screen.getByText(/已允许 · 工作区写入/);
    expect(result.className).toContain("s-succeeded");
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("SEC-04: 聊天内审批「拒绝」→ 状态机切 denied（按钮消失 + 已拒绝反馈）", async () => {
  injected.current = new MockDataSource();
  const app = await renderApp();
  try {
    await screen.findByText("需要确认");
    expect(screen.getByText("等待你的决定")).toBeTruthy();

    await app.user.click(screen.getByRole("button", { name: "拒绝" }));

    const result = screen.getByText(/已拒绝 · 工作区写入/);
    expect(result.className).toContain("s-failed");
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

/* ---------------------------------------------------------------------------
 * A5 lane（OBS-05：Desktop UI→日志关联）：
 * - 错误回放源复用本文件 stepwiseReplaySource（turn.failed 终态 → projector
 *   "运行错误"状态行，与 A4b CHAT-06 同一投影路径）；
 * - queryActivity 经 overrideSource 脚本化：ChatView 的会话级解析调用
 *   ({sessionId,status:"failed"}) 与日志页 traceId 预填查询分别断言；
 * - 脱敏红线：凭据片段不进入错误文案、诊断引用与整页（服务端真实链路的
 *   errorMessage 经 sanitizeSensitiveText 脱敏，fixture 与其保持一致）。
 * ------------------------------------------------------------------------- */

function makeFailedActivityRow(sessionId: string, traceId: string): ActivityLogRow {
  return {
    id: 901,
    recordedAt: "2026-09-02T10:00:00+08:00",
    eventName: "turn.failed",
    level: "error",
    status: "failed",
    category: "turn",
    producerComponent: "SessionRuntime",
    durationMs: 120,
    sessionId,
    ownerAgentId: "yuan",
    traceId,
    payloadPreview: "{ errorCode: AUTHENTICATION_FAILED }",
  };
}

function a5ReplaySource(base: DesktopDataSource, threadId: string, userMessage: string): DesktopDataSource {
  const envelope = makeEnvelopeFactory();
  return stepwiseReplaySource(base, {
    threadId,
    userMessage,
    batches: [
      {
        atMs: 60,
        mark: true,
        events: [
          envelope("turn.started", { turnId: "turn-a5-1" }),
          envelope("message.started", { role: "assistant" }),
          envelope("message.delta", { delta: "即将失败…" }),
        ],
      },
      {
        atMs: 600,
        // 与真实链路一致：服务端在发出失败终态前已对 errorMessage 脱敏
        events: [envelope("turn.failed", { errorMessage: "HTTP 401 Unauthorized（凭据被拒绝）" })],
      },
    ],
  });
}

it("A5: 运行错误行渲染诊断引用 +「在日志中查看」跳转日志页按 traceId 预填（凭据不透出）", async () => {
  const base = new MockDataSource();
  const fakeKey = "sk-oc-e2e-leaky-key";
  const userMessage = "A5 诊断引用回放：错误行出现可跳转引用";
  const failedRow = makeFailedActivityRow("lane-a5-ref", "trace-a5-01");
  const activityCalls: ActivityFilter[] = [];
  injected.current = overrideSource(a5ReplaySource(base, "lane-a5-ref", userMessage), {
    queryActivity: (filter: ActivityFilter) => {
      activityCalls.push(filter);
      // ChatView 会话级解析（sessionId+failed）与日志页 traceId 预填查询都命中失败记录
      if (filter.status === "failed" || filter.traceId !== undefined) {
        return Promise.resolve({ rows: [failedRow], nextCursor: null });
      }
      return Promise.resolve({ rows: [], nextCursor: null });
    },
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(userMessage);
    await composer.pressEnter();

    // 运行错误行出现 → 解析出诊断引用（短引用 + title 完整 traceId）
    await screen.findByText("运行错误");
    const ref = await screen.findByText(/诊断引用 /);
    expect(ref.getAttribute("title")).toBe("trace-a5-01");
    expect(ref.textContent).toContain("trace-a5");

    // 凭据/英文原文不透出：错误行、引用、整页均不含
    expect(screen.queryByText(new RegExp(fakeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull();
    expect(screen.queryByText("Unauthorized")).toBeNull();

    // 跳转：日志页活动 tab + traceId 预填 + 过滤参数真实下发 + 失败记录可见
    await app.user.click(screen.getByRole("button", { name: "在日志中查看" }));
    await screen.findByRole("heading", { name: "日志" });
    const traceInput = screen.getByPlaceholderText("traceId") as HTMLInputElement;
    expect(traceInput.value).toBe("trace-a5-01");
    await screen.findByText("turn.failed");
    const traceQuery = activityCalls.find((filter) => filter.traceId !== undefined);
    expect(traceQuery?.traceId).toBe("trace-a5-01");
    expect(screen.queryByText(fakeKey)).toBeNull();
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("A5: 会话级解析失败时错误行回退会话引用（server origin，traceId=sessionId）", async () => {
  const base = new MockDataSource();
  const userMessage = "A5 回退引用回放：解析失败回退会话 id";
  injected.current = overrideSource(a5ReplaySource(base, "lane-a5-fallback", userMessage), {
    queryActivity: () => Promise.reject(new Error("日志服务离线")),
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type(userMessage);
    await composer.pressEnter();

    // 解析查询失败 → 回退会话 id（会话路由以 sessionId 作为 traceId 盖章）
    await screen.findByText("运行错误");
    const ref = await screen.findByText(/诊断引用 /);
    expect(ref.getAttribute("title")).toBe("lane-a5-fallback");
    expect(ref.textContent).toContain("tr-lane-a5");
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});

it("A5: 纯 IPC 失败本地引用降级——alert 显示 ipc- 短引用（无服务端 traceId），原始错误不透出", async () => {
  const fixedLocal: ErrorCorrelation = {
    traceId: "9a5b7c3d-0000-0000-0000-000000000001",
    origin: "local",
    at: "2026-09-02T10:00:00+08:00",
  };
  const source = overrideSource(new MockDataSource(), {
    createThread: () => Promise.reject(new CorrelatedError("请求失败（0）", fixedLocal)),
  });
  injected.current = source;
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    const composer = makeComposerPO(app.user);
    await composer.type("A5 纯 IPC 失败降级");
    await composer.pressEnter();

    // isOffline 分支中文文案 + 本地短引用（ipc- 前缀，title 为完整 id）
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("连接已断开，请检查本地服务是否运行，恢复后会自动重连。");
    expect(alert.textContent).toContain("ipc-9a5b7c3d");
    expect(alert.querySelector("code")?.getAttribute("title")).toBe(fixedLocal.traceId);
    // 原始英文/状态码不透出
    expect(alert.textContent).not.toContain("请求失败");
  } finally {
    app.consoleTracker.restore();
    injected.current = null;
  }
  app.consoleTracker.expectNoErrors();
});
