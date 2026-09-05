/**
 * L5 · CHAT-04（无已配置凭据模型时发送被拦）+ SSE 固定回放序列冒烟。
 * CHAT-04 注入"全部 Provider 未配置凭据"状态（Mock fixture 注入表：empty/error 域），
 * 断言中文错误 +「去配置 Provider」入口；回放用 fixtures/sse 固定 Envelope 序列驱动 projector。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
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
