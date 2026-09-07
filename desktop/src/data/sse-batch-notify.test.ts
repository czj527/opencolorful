import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcDataSource } from "./ipc-source.js";
import type { ChatSnapshot } from "./projector.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复回归（§10-6）：SSE 合批窗口内通知去重。
// 缺陷背景：trailing flush 对队列中每个事件调用 applyChatEvent，而
// applyChatEvent 内部逐事件 notify——N 个排队事件产生 N+1 次 handler
// 调用与 N+1 次 React 状态更新（合批语义的本意是"只通知一次"）。
// 修复后：通知只发生在合批边界——leading 事件应用后一次、trailing
// flush 整批应用后一次；N 个排队事件恰好 1 次通知。
// ═══════════════════════════════════════════════════════════════

interface FrameCapture {
  emit(frame: DesktopApiFrame): void;
}

/** 手动驱动的 rAF 队列：合批窗口的开启/关闭完全由用例控制（确定性，不依赖宿主时钟） */
let rafQueue: Map<number, FrameRequestCallback>;
let rafSeq: number;

beforeEach(() => {
  rafQueue = new Map();
  rafSeq = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    rafSeq += 1;
    rafQueue.set(rafSeq, callback);
    return rafSeq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
  // 健康巡检定时器不进入用例时钟（构造即注册，用例内不应触发）
  vi.stubGlobal("setInterval", (() => 0) as unknown as typeof setInterval);
});

afterEach(() => {
  delete (window as { desktopApi?: DesktopApi }).desktopApi;
  vi.unstubAllGlobals();
});

/** 记录 subId 分配与事件帧的 DesktopApi 桩（请求面按需最小实现）。 */
function makeFakeApi(historyPayload: unknown): { api: DesktopApi; capture: FrameCapture } {
  const capture: FrameCapture = { emit: () => {} };
  let subSeq = 0;
  const api: DesktopApi = {
    invoke: async (method: string, path: string) => {
      if (path === "/api/health") return { ok: true, status: 200, data: {}, base: "http://127.0.0.1:4310" };
      if (method === "GET" && path.includes("/entries")) {
        // 分支条目重载路径（turn 终态/切换消费 pendingBranchReload）：空条目视图
        return { ok: true, status: 200, data: { sessionId: "sess-1", branchId: null, entries: [] }, base: "http://127.0.0.1:4310" };
      }
      if (method === "GET" && path.startsWith("/api/sessions/")) {
        return { ok: true, status: 200, data: historyPayload, base: "http://127.0.0.1:4310" };
      }
      if (method === "POST" && path.endsWith("/messages")) {
        return { ok: true, status: 202, data: { status: "accepted", streamId: "stream-1" }, base: "http://127.0.0.1:4310" };
      }
      return { ok: false, status: 404, data: { message: `未预期的请求 ${method} ${path}` }, base: "http://127.0.0.1:4310" };
    },
    subscribeEvents: () => `sub-${subSeq++}`,
    unsubscribeEvents: () => {},
    onEvent: (handler) => {
      capture.emit = (frame: DesktopApiFrame) => handler({ subId: "sub-0", frame });
      return () => {};
    },
  };
  return { api, capture };
}

function envelopeFrame(data: string): DesktopApiFrame {
  return { id: null, event: "message", data };
}

function deltaEnvelopeJson(streamId: string, sequence: number, delta: string): string {
  return JSON.stringify({
    eventId: `evt-${streamId}-${sequence}`,
    streamId,
    sequence,
    timestamp: "2026-09-07T00:00:00.000Z",
    type: "message.delta",
    payload: { delta },
  });
}

/** 空历史会话视图（ensureChatStream 的 REST 种子走 messageEntries 回退） */
const emptyHistory = {
  id: "sess-1",
  title: "合批回归会话",
  agentId: null,
  messageEntries: [],
  todos: [],
};

async function attachChatCollector(historyPayload: unknown = emptyHistory): Promise<{
  source: IpcDataSource;
  capture: FrameCapture;
  notifications: ChatSnapshot[];
  flush: () => Promise<void>;
}> {
  const { api, capture } = makeFakeApi(historyPayload);
  // IpcDataSource 唯一构造入口是 probe()（读取 window.desktopApi + health 探测）；
  // 用例把桩 api 挂到 window 上走真实装配链
  (window as { desktopApi?: DesktopApi }).desktopApi = api;
  const source = await IpcDataSource.probe();
  if (source === null) throw new Error("桩 api 下 probe() 不应返回 null");
  const notifications: ChatSnapshot[] = [];
  const unsubscribe = source.subscribeChat("sess-1", (snapshot) => {
    notifications.push(snapshot);
  });
  void unsubscribe;
  // subscribeChat 的第一次通知是同步注册回调；ensureChatStream 的历史装载是异步
  // （Promise.then），等它落定后再让用例取基线，避免异步通知污染计数
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    source,
    capture,
    notifications,
    flush: async () => {
      // 触发当前合批窗口的 trailing flush（rAF 已被替换为手动队列）
      for (const callback of [...rafQueue.values()]) callback(0);
      rafQueue.clear();
      // 让 flush 内触发的异步链（如分支条目重载）落定
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("SSE 合批通知去重（P1 审计修复回归）", () => {
  it("合批窗口内 N 个排队事件只产生 1 次 trailing 通知（leading + trailing 共 2 次边界通知）", async () => {
    const { source, capture, notifications, flush } = await attachChatCollector();

    // 发送 prompt：历史种子/乐观消息通知进入基线；markPromptSent 后流事件可被收养
    await source.sendPrompt("sess-1", "提问");
    const baseline = notifications.length;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // leading 事件：开启合批窗口，立即应用并通知一次（首个 token 延迟语义）
    capture.emit(envelopeFrame(deltaEnvelopeJson("stream-1", 1, "你")));
    const afterLeading = notifications.length;
    expect(afterLeading).toBe(baseline + 1);

    // 合批窗口内再入队 4 个 delta：修复前 flush 逐事件 notify（4+1=5 次）
    for (let index = 2; index <= 5; index += 1) {
      capture.emit(envelopeFrame(deltaEnvelopeJson("stream-1", index, `字${index}`)));
    }
    // 入队是同步的：窗口未关闭前通知数不变
    expect(notifications.length).toBe(afterLeading);

    await flush();

    // 修复语义：通知总数 = leading 1 次 + trailing 1 次（修复前为 1 + 4 + 1）
    expect(notifications.length).toBe(afterLeading + 1);
    // 且最后一次通知已应用全部排队 delta（去重不丢事件，消息正文完整）
    const last = notifications[notifications.length - 1];
    const messageItems = last.items.filter((item) => item.type === "message");
    const lastMessage = messageItems[messageItems.length - 1];
    const body = lastMessage !== undefined && "body" in lastMessage ? lastMessage.body : "";
    expect(body).toContain("字5");
  });

  it("空 flush（窗口关闭时无排队事件）不产生通知", async () => {
    const { capture, notifications, flush } = await attachChatCollector();

    // 只发 leading 事件；flush 触发时 pending 为空 → 不通知
    capture.emit(envelopeFrame(deltaEnvelopeJson("stream-1", 1, "首帧")));
    const afterLeading = notifications.length;
    await flush();
    expect(notifications.length).toBe(afterLeading);
  });

  it("turn 终态的挂起分支重载不受影响：终态事件在合批窗口内仍被应用", async () => {
    const { source, capture, notifications, flush } = await attachChatCollector();

    // sendPrompt：本地乐观消息 + markPromptSent（pendingPrompt=true、挂起分支重载）
    await source.sendPrompt("sess-1", "触发分支重载的消息");
    const afterPrompt = notifications.length;
    expect(afterPrompt).toBeGreaterThanOrEqual(1);

    capture.emit(envelopeFrame(deltaEnvelopeJson("stream-1", 1, "回")));
    // turn 终态在合批窗口内到达（入队），flush 时先应用再消费挂起重载
    capture.emit(envelopeFrame(JSON.stringify({
      eventId: "evt-turn-1",
      streamId: "stream-1",
      sequence: 2,
      timestamp: "2026-09-07T00:00:01.000Z",
      type: "turn.completed",
      payload: {},
    })));

    await flush();

    // 通知有界：窗口内共 2 次边界通知（leading + trailing）；第 3 次来自
    // flush 之后分支条目重载落定（reloadBranchEntries 在窗口外通知，属既有语义）
    expect(notifications.length).toBe(afterPrompt + 3);
    // turn.completed 已被应用：streaming 收敛为 false（终态翻转）
    const last = notifications[notifications.length - 1];
    expect(last.streaming).toBe(false);
  });
});
