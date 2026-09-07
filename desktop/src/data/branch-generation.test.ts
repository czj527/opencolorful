import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcDataSource } from "./ipc-source.js";
import type { ChatSnapshot } from "./projector.js";
import type { BranchEntriesView } from "./source.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复回归（§10-5）：分支条目重载的并发代次守卫。
// 缺陷背景：switchBranch 的兜底重载与 session.branch.switched 事件重载、
// turn 终态挂起重载可能并发在途——慢的旧分支 GET 响应落地时整表重投影，
// 覆盖快的新分支响应（timeline 显示已被切走的分支内容）。
// 修复后：每次发出重载前递增 per-session 代次，响应落地校验，过期丢弃。
// ═══════════════════════════════════════════════════════════════

interface FrameCapture {
  emit(frame: DesktopApiFrame): void;
}

/** 手动驱动的 rAF 队列（确定性，不依赖宿主时钟） */
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
  vi.stubGlobal("setInterval", (() => 0) as unknown as typeof setInterval);
});

afterEach(() => {
  delete (window as { desktopApi?: DesktopApi }).desktopApi;
  vi.unstubAllGlobals();
});

interface Deferred {
  resolve(value: unknown): void;
}

/** entries GET 可控（deferred）的 DesktopApi 桩：按 branchId 查询参数区分响应；同 path 并发请求按发出顺序逐个 settle */
function makeControllableApi(historyPayload: unknown): {
  api: DesktopApi;
  capture: FrameCapture;
  settleEntry(branchQuery: string, view: BranchEntriesView): void;
  entryCalls: string[];
} {
  const capture: FrameCapture = { emit: () => {} };
  const pending: Array<{ path: string; resolve: (value: unknown) => void; settled: boolean }> = [];
  const entryCalls: string[] = [];
  let subSeq = 0;
  const api: DesktopApi = {
    invoke: async (method: string, path: string) => {
      if (path === "/api/health") return { ok: true, status: 200, data: {}, base: "http://127.0.0.1:4310" };
      if (method === "GET" && path.includes("/entries")) {
        entryCalls.push(path);
        return await new Promise((resolve) => {
          pending.push({ path, resolve: (value: unknown) => resolve(value as never), settled: false });
        }) as never;
      }
      if (method === "GET" && path.startsWith("/api/sessions/")) {
        return { ok: true, status: 200, data: historyPayload, base: "http://127.0.0.1:4310" };
      }
      if (method === "POST" && path.endsWith("/branch/switch")) {
        return { ok: true, status: 200, data: {}, base: "http://127.0.0.1:4310" };
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
  return {
    api,
    capture,
    entryCalls,
    settleEntry(branchQuery: string, view: BranchEntriesView) {
      const entry = pending.find((item) => !item.settled && item.path.includes(branchQuery));
      if (entry === undefined) throw new Error(`未找到挂起的 entries 请求：${branchQuery}（在途：${pending.filter((item) => !item.settled).map((item) => item.path).join(", ") || "无"}）`);
      entry.settled = true;
      entry.resolve({ ok: true, status: 200, data: view, base: "http://127.0.0.1:4310" });
    },
  };
}

function envelopeFrame(data: string): DesktopApiFrame {
  return { id: null, event: "message", data };
}

function branchEntriesView(branchId: string, text: string): BranchEntriesView {
  return {
    branchId,
    currentBranchId: branchId,
    entries: [{
      entryId: `entry-${branchId}`,
      parentId: null,
      turnId: `turn-${branchId}`,
      type: "message",
      role: "user",
      text,
      timestamp: "2026-09-07T00:00:00.000Z",
    }],
  };
}

const emptyHistory = {
  id: "sess-1",
  title: "分支代次回归会话",
  agentId: null,
  messageEntries: [],
  todos: [],
};

async function attach(): Promise<{
  source: IpcDataSource;
  capture: FrameCapture;
  notifications: ChatSnapshot[];
  settleEntry(branchQuery: string, view: BranchEntriesView): void;
}> {
  const { api, capture, settleEntry } = makeControllableApi(emptyHistory);
  (window as { desktopApi?: DesktopApi }).desktopApi = api;
  const source = await IpcDataSource.probe();
  if (source === null) throw new Error("桩 api 下 probe() 不应返回 null");
  const notifications: ChatSnapshot[] = [];
  source.subscribeChat("sess-1", (snapshot) => {
    notifications.push(snapshot);
  });
  // 历史装载（异步 GET）落定
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    source,
    capture,
    notifications,
    settleEntry,
  };
}

function lastItems(notifications: ChatSnapshot[]): string[] {
  const last = notifications[notifications.length - 1];
  return last.items
    .filter((item) => item.type === "message")
    .map((item) => ("body" in item ? item.body : ""));
}

describe("分支条目重载并发代次守卫（P1 审计修复回归）", () => {
  it("switch 兜底重载与 switched 事件重载并发：旧代次响应被丢弃，新代次响应生效", async () => {
    const harness = await attach();
    const { source, capture, notifications, settleEntry } = harness;

    // 1. switchBranch：POST 成功后兜底重载 GET#1（代次 1，挂起）
    void source.switchBranch("sess-1", "b2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // 2. SSE session.branch.switched 事件 → 事件驱动重载 GET#2（代次 2，取代 GET#1）
    capture.emit(envelopeFrame(JSON.stringify({
      eventId: "evt-switch-1",
      streamId: "branch-1",
      sequence: 1,
      timestamp: "2026-09-07T00:00:00.000Z",
      type: "session.branch.switched",
      payload: { branchId: "b2" },
    })));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // 3. GET#1（旧代次）先落：已被 GET#2 取代 → 整包丢弃，不产生通知
    settleEntry("branchId=b2", branchEntriesView("b2", "旧响应内容"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lastItems(notifications)).toEqual([]);

    // 4. GET#2（当前代次）落地 → 应用
    settleEntry("branchId=b2", branchEntriesView("b2", "新分支内容"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lastItems(notifications)).toEqual(["新分支内容"]);
  });

  it("快速连续切换：后发分支的响应落地后，先发分支的慢响应被丢弃", async () => {
    const harness = await attach();
    const { source, notifications, settleEntry } = harness;

    void source.switchBranch("sess-1", "b1");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    void source.switchBranch("sess-1", "b2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // b2 的响应先落（新代次）
    settleEntry("branchId=b2", branchEntriesView("b2", "B2 条目"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lastItems(notifications)).toEqual(["B2 条目"]);

    // b1 的响应后落（旧代次）→ 丢弃
    settleEntry("branchId=b1", branchEntriesView("b1", "B1 条目"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lastItems(notifications)).toEqual(["B2 条目"]);
  });

  it("无并发时（单次重载）代次校验放行，重载语义不变", async () => {
    const harness = await attach();
    const { source, notifications, settleEntry } = harness;

    void source.switchBranch("sess-1", "b1");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    settleEntry("branchId=b1", branchEntriesView("b1", "唯一重载"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lastItems(notifications)).toEqual(["唯一重载"]);
  });
});
