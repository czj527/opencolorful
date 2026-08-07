import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentReplayEnvelope, SubagentStreamEvent } from "../../lib/types.js";
import { SubagentStreamClient, subagentStreamUrl } from "./subagent-stream.js";

// ─── Fake EventSource：记录 URL、事件监听器，测试手动 emit ───────

interface FakeMessageEvent {
  readonly data: string;
  readonly lastEventId: string;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Set<(event: FakeMessageEvent) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: FakeMessageEvent) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeMessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  emit(type: string, data: unknown, lastEventId = ""): void {
    const event = { data: JSON.stringify(data), lastEventId };
    const set = this.listeners.get(type);
    if (set !== undefined) {
      for (const listener of set) listener(event);
    }
    if (type === "message") this.onmessage?.(event);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

const OWNERSHIP = { ownerAgentId: "agent-a", parentSessionId: "session-1" };
const THREAD_ID = "sat_0123456789ab" as const;

function envelope(seq: number, kind: "message" | "run" | "tool" = "message"): SubagentReplayEnvelope {
  if (kind === "run") {
    return {
      seq,
      threadId: THREAD_ID,
      at: "2026-08-07T10:00:00.000Z",
      event: {
        kind: "run",
        run: {
          runId: `sar_run${seq}`,
          threadId: THREAD_ID,
          ordinal: 1,
          status: "running",
          triggerMessageId: "sam_trigger",
          snapshotId: null,
          snapshotJson: null,
          limits: {
            startupTimeoutMs: 60000, providerFirstEventTimeoutMs: 90000, providerEventIdleTimeoutMs: 180000,
            idleTimeoutMs: 180000, totalRunTimeoutMs: 1800000, maxModelIterations: 24, maxToolCalls: 64, maxTotalTokens: 200000,
          },
          result: null,
          reasonCode: null,
          auditPendingJson: null,
          currentPhase: null,
          currentTool: "read",
          iterationCount: 1,
          toolCallCount: 1,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          lastActivityAt: "2026-08-07T10:00:00.000Z",
          startedAt: "2026-08-07T09:59:00.000Z",
          finishedAt: null,
          leaseBootId: null,
          leaseHolderId: null,
          leaseExpiresAt: null,
          revision: 1,
          createdAt: "2026-08-07T09:59:00.000Z",
          updatedAt: "2026-08-07T10:00:00.000Z",
        },
      },
    };
  }
  return {
    seq,
    threadId: THREAD_ID,
    at: "2026-08-07T10:00:00.000Z",
    event: {
      kind: "message",
      message: {
        messageId: `sam_msg${seq}`,
        threadId: THREAD_ID,
        runId: "sar_run1",
        sequence: seq,
        messageType: "progress",
        sender: { kind: "subagent", id: "sar_run1" },
        recipient: { kind: "parent_agent", id: OWNERSHIP.ownerAgentId },
        deliveryMode: "immediate",
        deliveryStatus: "delivered",
        consumedAt: null,
        createdAt: "2026-08-07T10:00:00.000Z",
        traceId: `trace-${seq}`,
        parts: [{ kind: "text", text: `进展 ${seq}` }],
      },
    },
  };
}

function transcriptSnapshot() {
  return {
    thread: {
      threadId: THREAD_ID,
      ownerAgentId: OWNERSHIP.ownerAgentId,
      parentSessionId: OWNERSHIP.parentSessionId,
      createdFromTurnId: null,
      title: "测试任务",
      status: "open",
      modelProviderId: "faux",
      modelId: "faux-model",
      modelSource: "parent_inherited",
      thinkingLevel: "off",
      workspaceCwd: "C:\\ws",
      capabilityCeiling: {
        ceilingHash: "h", workspaceAccess: "read", toolIds: [], pluginContributionIds: [], skillRefs: [], network: "inherit", fixedDenials: [],
      },
      contextPacketHash: "h",
      nextMessageSequence: 3,
      nextRunOrdinal: 2,
      createdAt: "2026-08-07T09:00:00.000Z",
      updatedAt: "2026-08-07T09:00:00.000Z",
      lastActivityAt: "2026-08-07T09:00:00.000Z",
      closedAt: null,
      closeReason: null,
      auditPendingJson: null,
    },
    runs: [],
    messages: [],
    artifacts: [],
    taskBrief: null,
    contextPacket: null,
    nextMessageSequence: 0,
    truncated: false,
  };
}

let collected: SubagentStreamEvent[];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  collected = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(reconnectDelayMs = 10): SubagentStreamClient {
  return new SubagentStreamClient({
    baseUrl: "",
    threadId: THREAD_ID,
    ownership: OWNERSHIP,
    onEvent: (event) => { collected.push(event); },
    reconnectDelayMs,
  });
}

describe("SubagentStreamClient", () => {
  it("连接 URL 携带归属参数与 sinceSeq 游标", () => {
    const url = subagentStreamUrl("http://localhost:8787", THREAD_ID, OWNERSHIP, 42);
    expect(url).toContain("/api/subagents/threads/sat_0123456789ab/stream");
    expect(url).toContain("ownerAgentId=agent-a");
    expect(url).toContain("parentSessionId=session-1");
    expect(url).toContain("sinceSeq=42");
  });

  it("envelope 事件按 seq 去重，不重复追加", () => {
    const client = makeClient();
    client.connect();
    const source = FakeEventSource.instances[0]!;
    source.emit("message", envelope(1), "1");
    source.emit("message", envelope(1), "1");
    source.emit("run", envelope(2), "2");
    source.emit("message", envelope(3), "3");
    expect(collected).toHaveLength(3);
    expect(client.getLastSeq()).toBe(3);
    client.dispose();
  });

  it("reset 事件通知调用方（stale cursor，须以 snapshot 重建）", () => {
    const client = makeClient();
    client.connect();
    FakeEventSource.instances[0]!.emit("reset", { reason: "stream 已截断或服务重启", lastSeq: 99 }, "99");
    expect(collected).toEqual([
      { type: "reset", reason: "stream 已截断或服务重启", lastSeq: 99 },
    ]);
    expect(client.getLastSeq()).toBe(99);
    client.dispose();
  });

  it("snapshot 事件整体重建基线并重置去重集合（旧 seq 仍按高水位丢弃）", () => {
    const client = makeClient();
    client.connect();
    const source = FakeEventSource.instances[0]!;
    source.emit("message", envelope(1), "1");
    source.emit("snapshot", transcriptSnapshot(), "50");
    source.emit("message", envelope(1), "1"); // ≤ 高水位 50 → 丢弃（不重复追加）
    source.emit("message", envelope(51), "51"); // snapshot 后新 seq → 放行
    expect(collected.map((event) => event.type)).toEqual(["envelope", "snapshot", "envelope"]);
    expect(collected[1]).toMatchObject({ type: "snapshot" });
    expect(collected[2]).toMatchObject({ type: "envelope" });
    client.dispose();
  });

  it("断线后按最新游标自动重建连接（sinceSeq 不重不漏）", async () => {
    const client = makeClient();
    client.connect();
    const first = FakeEventSource.instances[0]!;
    first.emit("message", envelope(5), "5");
    expect(FakeEventSource.instances).toHaveLength(1);
    first.fail(); // readyState CONNECTING → 计划重连
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toContain("sinceSeq=5");
    second.emit("message", envelope(5), "5"); // 重复 seq 被去重
    second.emit("message", envelope(6), "6");
    const messages = collected.filter((event) => event.type === "envelope");
    expect(messages).toHaveLength(2);
    client.dispose();
  });

  it("dispose 后停止重连且不再接收事件", async () => {
    const client = makeClient();
    client.connect();
    const source = FakeEventSource.instances[0]!;
    client.dispose();
    source.emit("message", envelope(1), "1");
    expect(collected).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
