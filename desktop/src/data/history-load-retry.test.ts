import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcDataSource } from "./ipc-source.js";
import type { ChatSnapshot } from "./projector.js";

// ═══════════════════════════════════════════════════════════════
// F2 flaky 回归：ensureChatStream 历史装载独立错误处理。
// 缺陷背景：historyLoaded 在 GET 前置位（失败永不重试），且装载失败走
// pushChannelError/markPromptFailed——历史装载失败被误当「发送失败」，
// 清掉 streaming/pendingPrompt 并推错误行。
// 修复后：historyLoaded 装载成功才置位；失败按 300/900/2000ms 退避重试最多
// 3 次；3 次均失败只推独立状态行（「历史加载失败/请刷新重试」），
// 绝不触碰 streaming/pendingPrompt。
// ═══════════════════════════════════════════════════════════════

const SESSION_ID = "sess-hist";
const BASE = "http://127.0.0.1:4310";

const historyPayload = {
  id: SESSION_ID,
  title: "历史装载回归会话",
  agentId: null,
  messageEntries: [{ role: "user", content: "历史消息一" }],
  todos: [],
};

interface ApiStub {
  api: DesktopApi;
  historyCalls(): number;
}

/** 历史 GET 前 failTimes 次失败（status 0 网络），之后成功 */
function makeApi(failTimes: number): ApiStub {
  let historyCalls = 0;
  const api: DesktopApi = {
    invoke: async (method: string, path: string) => {
      if (path === "/api/health") return { ok: true, status: 200, data: {}, base: BASE };
      if (method === "GET" && path === `/api/sessions/${SESSION_ID}`) {
        historyCalls += 1;
        if (historyCalls <= failTimes) {
          return { ok: false, status: 0, data: { code: "NETWORK", message: "网络请求失败" }, base: BASE };
        }
        return { ok: true, status: 200, data: historyPayload, base: BASE };
      }
      if (method === "POST" && path === `/api/sessions/${SESSION_ID}/messages`) {
        return { ok: true, status: 202, data: { status: "accepted", streamId: "stream-1" }, base: BASE };
      }
      return { ok: false, status: 404, data: { message: `未预期的请求 ${method} ${path}` }, base: BASE };
    },
    subscribeEvents: () => "sub-0",
    unsubscribeEvents: () => {},
    onEvent: () => () => {},
  };
  return { api, historyCalls: () => historyCalls };
}

async function attach(failTimes: number): Promise<{
  source: IpcDataSource;
  stub: ApiStub;
  notifications: ChatSnapshot[];
}> {
  const stub = makeApi(failTimes);
  (window as { desktopApi?: DesktopApi }).desktopApi = stub.api;
  const source = await IpcDataSource.probe();
  if (source === null) throw new Error("桩 api 下 probe() 不应返回 null");
  const notifications: ChatSnapshot[] = [];
  source.subscribeChat(SESSION_ID, (snapshot) => {
    notifications.push(snapshot);
  });
  return { source, stub, notifications };
}

function statusTitles(notifications: ChatSnapshot[]): string[] {
  const last = notifications[notifications.length - 1];
  return last === undefined
    ? []
    : last.items.filter((item) => item.type === "event" && "title" in item).map((item) => ("title" in item ? item.title : ""));
}

function messageBodies(notifications: ChatSnapshot[]): string[] {
  const last = notifications[notifications.length - 1];
  return last === undefined
    ? []
    : last.items.filter((item) => item.type === "message").map((item) => ("body" in item ? item.body : ""));
}

/** 轮询至条件成立或超时（真实退避定时器，不给测试引入假定时器脆弱性） */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

beforeEach(() => {
  // 阻断 startHealthWatch 的真实 interval（与 branch-generation.test.ts 同法）
  vi.stubGlobal("setInterval", (() => 0) as unknown as typeof setInterval);
});

afterEach(() => {
  delete (window as { desktopApi?: DesktopApi }).desktopApi;
  vi.unstubAllGlobals();
});

describe("ensureChatStream 历史装载独立错误处理（F2 flaky 回归）", () => {
  it("首次装载失败后退避重试并恢复：历史正常装载，无「发送失败」误报", async () => {
    const { notifications, stub } = await attach(1);

    // 退避 300ms 后重试 → 成功装载
    expect(await waitFor(() => messageBodies(notifications).includes("历史消息一"), 2_000)).toBe(true);
    expect(stub.historyCalls()).toBe(2);
    expect(statusTitles(notifications)).not.toContain("发送失败");
    expect(statusTitles(notifications)).not.toContain("历史加载失败");
  });

  it("3 次重试均失败：只推独立状态行，不触碰 streaming、不误报发送失败", async () => {
    const { source, notifications, stub } = await attach(999);

    // 流式中的发送先建立（streaming=true），随后历史装载重试耗尽也不得清掉它
    await source.sendPrompt(SESSION_ID, "进行中的提问");
    const sent = notifications[notifications.length - 1];
    expect(sent.streaming).toBe(true);

    // 初始 + 3 次退避（300/900/2000ms）全部失败后，状态行出现
    expect(await waitFor(() => stub.historyCalls() >= 4, 6_000)).toBe(true);
    expect(await waitFor(() => statusTitles(notifications).includes("历史加载失败"), 2_000)).toBe(true);
    const last = notifications[notifications.length - 1];
    // streaming 未被历史装载失败清掉；无「发送失败」误报
    expect(last.streaming).toBe(true);
    expect(statusTitles(notifications)).not.toContain("发送失败");
    // 初始 1 次 + 重试 3 次，不无限重试
    expect(stub.historyCalls()).toBe(4);
  });
});
