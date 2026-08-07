import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { ApiClient } from "../../lib/api-client.js";
import type {
  ActivityPage,
  ActivityRow,
  SubagentArtifactRecord,
  SubagentOwnership,
  SubagentResultV1,
  SubagentRunRecord,
  SubagentRunStatus,
  SubagentSteerV1,
  SubagentTaskBriefV1,
  SubagentThreadId,
  SubagentThreadRecord,
  SubagentThreadTranscript,
  SubagentTranscriptMessage,
} from "../../lib/types.js";
import { SubagentCard, SubagentCardList } from "./SubagentCard.jsx";
import { SubagentPanel } from "./SubagentPanel.jsx";
import { SubagentDefaultsSection } from "../settings/sections/SubagentDefaultsSection.jsx";
import { useSubagentThreads } from "./use-subagent-threads.js";
import { renderWithTheme } from "../../test/render.js";

// ─── Fake EventSource（面板流测试手动驱动）──────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Set<(event: { data: string; lastEventId: string }) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void): void {
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
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

// ─── fetch mock：按 URL 路由到 fixture 响应（logs 同栈模式）──────

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", mockFetch);

interface FetchRoute {
  readonly match: (url: string) => boolean;
  readonly handler: (url: string) => Response;
}

let routes: FetchRoute[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function route(prefix: string, data: unknown, status = 200): FetchRoute {
  return { match: (url) => url.startsWith(prefix), handler: () => jsonResponse(data, status) };
}

beforeEach(() => {
  routes = [];
  FakeEventSource.instances = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const item of routes) {
      if (item.match(url)) return item.handler(url);
    }
    throw new Error(`测试中未预期的请求: ${url}`);
  });
  vi.stubGlobal("EventSource", FakeEventSource);
});

// ─── fixtures ───────────────────────────────────────────────────

const OWNERSHIP: SubagentOwnership = { ownerAgentId: "agent-a", parentSessionId: "session-1" };
const THREAD_A: SubagentThreadId = "sat_aaaaaaaaaaaa";
const THREAD_B: SubagentThreadId = "sat_bbbbbbbbbbbb";

function threadRecord(threadId: SubagentThreadId, overrides: Partial<SubagentThreadRecord> = {}): SubagentThreadRecord {
  return {
    threadId,
    ownerAgentId: OWNERSHIP.ownerAgentId,
    parentSessionId: OWNERSHIP.parentSessionId,
    createdFromTurnId: null,
    title: "整理项目文档",
    status: "open",
    modelProviderId: "faux",
    modelId: "faux-model",
    modelSource: "parent_inherited",
    thinkingLevel: "off",
    workspaceCwd: "C:\\ws",
    capabilityCeiling: {
      ceilingHash: "ceiling-hash-1",
      workspaceAccess: "read",
      toolIds: ["read", "list"],
      pluginContributionIds: [],
      skillRefs: [],
      network: "inherit",
      fixedDenials: ["search_memory", "spawn_subagent"],
    },
    contextPacketHash: "ctx-hash",
    nextMessageSequence: 100,
    nextRunOrdinal: 2,
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T09:05:00.000Z",
    lastActivityAt: "2026-08-07T09:05:00.000Z",
    closedAt: null,
    closeReason: null,
    auditPendingJson: null,
    ...overrides,
  };
}

function runRecord(ordinal: number, status: SubagentRunStatus, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const runId: SubagentRunRecord["runId"] = `sar_run${ordinal}`;
  return {
    runId,
    threadId: THREAD_A,
    ordinal,
    status,
    triggerMessageId: "sam_trigger",
    snapshotId: `sas_snap${ordinal}`,
    snapshotJson: null,
    limits: {
      startupTimeoutMs: 60000, providerFirstEventTimeoutMs: 90000, providerEventIdleTimeoutMs: 180000,
      idleTimeoutMs: 180000, totalRunTimeoutMs: 1800000, maxModelIterations: 24, maxToolCalls: 64, maxTotalTokens: 200000,
    },
    result: null,
    reasonCode: null,
    auditPendingJson: null,
    currentPhase: null,
    currentTool: null,
    iterationCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastActivityAt: "2026-08-07T09:05:00.000Z",
    startedAt: "2026-08-07T09:01:00.000Z",
    finishedAt: null,
    leaseBootId: null,
    leaseHolderId: null,
    leaseExpiresAt: null,
    revision: 1,
    createdAt: "2026-08-07T09:01:00.000Z",
    updatedAt: "2026-08-07T09:05:00.000Z",
    ...overrides,
  };
}

const RESULT_OK: SubagentResultV1 = {
  version: 1,
  disposition: "satisfied",
  summary: "已完成文档整理并输出清单",
  criteria: [{ criterion: "文档齐全", status: "met", evidenceRefs: ["ref-1"] }],
  artifacts: [],
  unresolvedIssues: [],
  recommendedNextAction: "accept",
};

function messageFixture(
  sequence: number,
  messageType: SubagentTranscriptMessage["messageType"],
  overrides: Partial<SubagentTranscriptMessage> = {},
): SubagentTranscriptMessage {
  return {
    messageId: `sam_msg${sequence}`,
    threadId: THREAD_A,
    runId: "sar_run1",
    sequence,
    messageType,
    sender: { kind: "subagent", id: "sar_run1" },
    recipient: { kind: "parent_agent", id: OWNERSHIP.ownerAgentId },
    deliveryMode: "immediate",
    deliveryStatus: "delivered",
    consumedAt: null,
    createdAt: `2026-08-07T09:0${sequence}:00.000Z`,
    traceId: `trace-${sequence}`,
    parts: [{ kind: "text", text: `消息正文 ${sequence}` }],
    ...overrides,
  };
}

const TASK_BRIEF: SubagentTaskBriefV1 = {
  version: 1,
  title: "整理项目文档",
  objective: "整理 README 与架构文档",
  successCriteria: ["文档结构清晰"],
  deliverables: ["清单.md"],
  context: [],
  constraints: ["不修改代码"],
  nonGoals: [],
  executionMode: "research",
  reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "both" },
};

const STEER_DATA: SubagentSteerV1 = {
  version: 1,
  targetRunId: "sar_run1",
  action: "add_constraint",
  instruction: "优先使用既有模板",
  reason: "保持风格一致",
  preserveCompletedWork: true,
  deliveryMode: "queue",
};

function steerMessage(sequence: number): SubagentTranscriptMessage {
  return messageFixture(sequence, "steer", {
    sender: { kind: "parent_agent", id: OWNERSHIP.ownerAgentId },
    parts: [{ kind: "data", schema: "subagent.steer.v1", value: STEER_DATA }],
  });
}

function resultMessage(sequence: number): SubagentTranscriptMessage {
  return messageFixture(sequence, "result", {
    parts: [{ kind: "data", schema: "subagent.result.v1", value: RESULT_OK }],
  });
}

function artifactRecord(index: number): SubagentArtifactRecord {
  return {
    artifactId: `saa_artifact${index}`,
    threadId: THREAD_A,
    runId: "sar_run1",
    kind: "text",
    name: `结果-${index}.md`,
    mimeType: "text/markdown",
    contentHash: "0123456789abcdef",
    sizeBytes: 2048,
    resourceKind: "subagent_artifact",
    resourceId: `saa_artifact${index}`,
    canonicalPath: null,
    visibility: "visible",
    createdAt: "2026-08-07T09:05:00.000Z",
  };
}

function transcriptFixture(overrides: Partial<SubagentThreadTranscript> = {}): SubagentThreadTranscript {
  return {
    thread: threadRecord(THREAD_A),
    runs: [runRecord(1, "succeeded", { result: RESULT_OK, finishedAt: "2026-08-07T09:05:00.000Z", totalTokens: 4600, inputTokens: 1200, outputTokens: 3400 })],
    messages: [
      messageFixture(1, "task", { parts: [{ kind: "data", schema: "subagent.task_brief.v1", value: TASK_BRIEF }] }),
      messageFixture(2, "progress"),
      steerMessage(3),
      messageFixture(4, "input_required", { parts: [{ kind: "text", text: "请确认输出目录" }] }),
      resultMessage(5),
    ],
    artifacts: [artifactRecord(1), artifactRecord(2)],
    taskBrief: TASK_BRIEF,
    contextPacket: null,
    nextMessageSequence: 5,
    truncated: false,
    ...overrides,
  };
}

function activityRow(threadId: SubagentThreadId, recordedAt: string): ActivityRow {
  return {
    id: 1,
    eventId: `evt-${threadId}`,
    recordedAt,
    occurredAt: recordedAt,
    eventName: "subagent.thread.created",
    category: "subagent",
    level: "info",
    status: null,
    significance: "notable",
    actorKind: "agent",
    actorId: "agent-a",
    executorKind: "service",
    executorId: "agent-server",
    targetKind: "subagent_thread",
    targetId: threadId,
    ownerAgentId: "agent-a",
    sessionId: "session-1",
    subagentThreadId: threadId,
    subagentRunId: null,
    traceId: `trace-${threadId}`,
    spanId: "span-1",
    parentSpanId: null,
    operationId: null,
    durationMs: null,
    errorCode: null,
    retryable: 0,
    producerComponent: "agent-server",
    producerProcessType: "server",
    payloadJson: JSON.stringify({ summaryCode: "subagent_thread_created" }),
  };
}

// ─── SubagentCard ───────────────────────────────────────────────

function cardData(transcript: SubagentThreadTranscript | null, overrides: Partial<{ loading: boolean; error: string | null; threadId: SubagentThreadId; createdAt: string }> = {}): Parameters<typeof SubagentCard>[0]["card"] {
  return {
    threadId: overrides.threadId ?? THREAD_A,
    createdAt: overrides.createdAt ?? "2026-08-07T09:00:00.000Z",
    transcript,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
  };
}

function renderCard(card = cardData(transcriptFixture()), onOpen = vi.fn(), onRequest = vi.fn()) {
  return renderWithTheme(
    <SubagentCard card={card} onOpen={onOpen} onRequestParentAction={onRequest} />,
  );
}

describe("SubagentCard", () => {
  it("渲染标题/状态/Run 序号/模型/Token/Artifact 数量", () => {
    renderCard();
    const root = document.querySelector("[data-thread-id='sat_aaaaaaaaaaaa']") as HTMLElement;
    expect(root).toBeTruthy();
    expect(within(root).getByText("整理项目文档")).toBeTruthy();
    expect(within(root).getByText("已完成")).toBeTruthy();
    expect(within(root).getByText("Run #1")).toBeTruthy();
    expect(within(root).getByText("faux/faux-model")).toBeTruthy();
    expect(within(root).getByText("↑1.2k ↓3.4k · 总 4.6k")).toBeTruthy();
    expect(within(root).getByText("2")).toBeTruthy();
  });

  it("终态卡片显示结果 disposition 与一行摘要", () => {
    renderCard();
    const root = document.querySelector("[data-thread-id='sat_aaaaaaaaaaaa']") as HTMLElement;
    const resultLine = within(root).getByTestId("subagent-card-result-sat_aaaaaaaaaaaa");
    expect(within(resultLine).getByText("已满足")).toBeTruthy();
    expect(within(resultLine).getByText("已完成文档整理并输出清单")).toBeTruthy();
  });

  it("活动 Run 显示「正在使用工具：read」阶段行", () => {
    renderCard(cardData(transcriptFixture({
      runs: [runRecord(1, "running", { currentTool: "read" })],
      messages: [messageFixture(1, "progress")],
    })));
    const root = document.querySelector("[data-thread-id='sat_aaaaaaaaaaaa']") as HTMLElement;
    expect(within(root).getByText("正在使用工具：read")).toBeTruthy();
  });

  it("点击卡片触发 onOpen（打开右侧面板）", () => {
    const onOpen = vi.fn();
    renderCard(cardData(transcriptFixture()), onOpen);
    const root = document.querySelector("[data-thread-id='sat_aaaaaaaaaaaa']") as HTMLElement;
    fireEvent.click(root);
    expect(onOpen).toHaveBeenCalledWith(THREAD_A);
  });

  it("Enter 键打开面板（键盘可访问）", () => {
    const onOpen = vi.fn();
    renderCard(cardData(transcriptFixture()), onOpen);
    const root = document.querySelector("[data-thread-id='sat_aaaaaaaaaaaa']") as HTMLElement;
    expect(root?.getAttribute("role")).toBe("button");
    fireEvent.keyDown(root as HTMLElement, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(THREAD_A);
  });

  it("活动 Run 显示只读请求按钮，点击发结构化请求且不直接控制", () => {
    const onRequest = vi.fn();
    renderCard(cardData(transcriptFixture({
      runs: [runRecord(1, "running")],
      messages: [messageFixture(1, "progress")],
    })), vi.fn(), onRequest);
    const cancelButton = screen.getByTestId("subagent-request-cancel-sat_aaaaaaaaaaaa");
    const askButton = screen.getByTestId("subagent-request-ask-sat_aaaaaaaaaaaa");
    fireEvent.click(cancelButton);
    expect(onRequest).toHaveBeenCalledWith(THREAD_A, "cancel", "整理项目文档");
    fireEvent.click(askButton);
    expect(onRequest).toHaveBeenCalledWith(THREAD_A, "ask", "整理项目文档");
  });

  it("面板无 steer/cancel/retry/grant 直接控制控件", () => {
    renderCard(cardData(transcriptFixture({
      runs: [runRecord(1, "running")],
      messages: [messageFixture(1, "progress")],
    })));
    expect(screen.queryByText("取消")).toBeNull();
    expect(screen.queryByText("重试")).toBeNull();
    expect(screen.queryByText("授予权限")).toBeNull();
    expect(screen.queryByText(/steer/i)).toBeNull();
  });

  it("终态 Run 不显示请求按钮，显示只读提示", () => {
    renderCard();
    expect(screen.queryByTestId("subagent-request-cancel-sat_aaaaaaaaaaaa")).toBeNull();
    expect(screen.getByText("只读卡片 · 点击查看详情")).toBeTruthy();
  });

  it("loading 状态显示加载行", () => {
    renderCard(cardData(null, { loading: true }));
    expect(screen.getByTestId("subagent-card-loading-sat_aaaaaaaaaaaa")).toBeTruthy();
  });

  it("error 状态显示错误信息", () => {
    renderCard(cardData(null, { error: "加载失败" }));
    const alert = screen.getByTestId("subagent-card-error-sat_aaaaaaaaaaaa");
    expect(alert.textContent).toContain("加载失败");
  });
});

describe("SubagentCardList", () => {
  it("多卡片按创建时间升序稳定展示，不因实时更新跳动", () => {
    renderWithTheme(
      <SubagentCardList
        cards={[
          cardData(transcriptFixture({ thread: threadRecord(THREAD_A) }), { threadId: THREAD_A, createdAt: "2026-08-07T09:00:00.000Z", loading: true }),
          cardData(transcriptFixture({ thread: threadRecord(THREAD_B, { title: "第二个任务" }) }), { threadId: THREAD_B, createdAt: "2026-08-07T09:02:00.000Z" }),
        ]}
        onOpen={vi.fn()}
        onRequestParentAction={vi.fn()}
      />,
    );
    const list = screen.getByTestId("subagent-card-list");
    const cards = list.querySelectorAll("[data-thread-id]");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("data-thread-id")).toBe(THREAD_A);
    expect(cards[1]?.getAttribute("data-thread-id")).toBe(THREAD_B);
  });
});

// ─── useSubagentThreads（发现 + 排序 + 会话切换重置）────────────

describe("useSubagentThreads", () => {
  it("发现线程并拉取 transcript，卡片按创建顺序稳定输出", async () => {
    const page: ActivityPage = {
      items: [
        activityRow(THREAD_B, "2026-08-07T09:02:00.000Z"),
        activityRow(THREAD_A, "2026-08-07T09:00:00.000Z"),
      ],
      nextCursor: null,
    };
    routes.push(
      route("/api/observability/activity", page),
      route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()),
      route("/api/subagents/threads/sat_bbbbbbbbbbbb/transcript", transcriptFixture({
        thread: threadRecord(THREAD_B, { title: "第二个任务" }),
      })),
    );
    const { result } = renderHook(() => useSubagentThreads({
      api: new ApiClient(""),
      ownership: OWNERSHIP,
      enabled: true,
      openPanelThreadId: null,
      discoverIntervalMs: 60_000,
    }));
    await waitFor(() => expect(result.current.cards).toHaveLength(2));
    expect(result.current.cards.map((card) => card.threadId)).toEqual([THREAD_A, THREAD_B]);
    expect(result.current.cards[0]?.transcript?.thread.title).toBe("整理项目文档");
    expect(result.current.cards[1]?.transcript?.thread.title).toBe("第二个任务");
  });

  it("切换父 Session 后清空卡片（不显示旧 Session Thread）", async () => {
    const pageA: ActivityPage = {
      items: [activityRow(THREAD_A, "2026-08-07T09:00:00.000Z")],
      nextCursor: null,
    };
    routes.push(
      { match: (url) => url.includes("sessionId=session-1") && url.includes("/api/observability/activity"), handler: () => jsonResponse(pageA) },
      { match: (url) => url.includes("sessionId=session-2") && url.includes("/api/observability/activity"), handler: () => jsonResponse({ items: [], nextCursor: null }) },
      route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()),
    );
    const { result, rerender } = renderHook(
      (props: { ownership: SubagentOwnership }) => useSubagentThreads({
        api: new ApiClient(""),
        ownership: props.ownership,
        enabled: true,
        openPanelThreadId: null,
        discoverIntervalMs: 60_000,
      }),
      { initialProps: { ownership: OWNERSHIP } },
    );
    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    rerender({ ownership: { ownerAgentId: "agent-b", parentSessionId: "session-2" } });
    await waitFor(() => expect(result.current.cards).toHaveLength(0));
  });
});

// ─── SubagentPanel ──────────────────────────────────────────────

// ApiClient 实例提升到渲染函数外：传入组件后保持引用稳定，
// 避免面板 hook 因 api 身份变化反复重拉（生产接线中 api 同样稳定）。
const panelApi = new ApiClient("");

function renderPanel(overrides: Partial<Parameters<typeof SubagentPanel>[0]> = {}) {
  return renderWithTheme(
    <SubagentPanel
      threadId={THREAD_A}
      ownership={OWNERSHIP}
      api={panelApi}
      enabled
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe("SubagentPanel", () => {
  it("加载并渲染 Header/Run strip/时间线/Artifacts", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()));
    renderPanel();

    expect(await screen.findByText("整理项目文档")).toBeTruthy();
    expect(screen.getByTestId("subagent-panel-status").textContent).toBe("已完成");
    expect(screen.getByTestId("subagent-panel-model").textContent).toBe("faux/faux-model");

    // Run strip：Run #1 + 结果 disposition
    expect(screen.getByTestId("run-tab-1").textContent).toContain("Run #1");
    expect(screen.getByTestId("run-tab-1").textContent).toContain("已满足");

    // Timeline：TaskBrief / 进展 / Steer / input_required / Result
    expect(screen.getByTestId("subagent-task-brief")).toBeTruthy();
    expect(screen.getByText("整理 README 与架构文档")).toBeTruthy();
    expect(screen.getByText("消息正文 2")).toBeTruthy();
    const steer = screen.getByTestId("steer-3");
    expect(within(steer).getByText("主 Agent 纠偏")).toBeTruthy();
    expect(within(steer).getByText(/动作 add_constraint/)).toBeTruthy();
    expect(within(steer).getByText("优先使用既有模板")).toBeTruthy();
    expect(within(steer).getByText(/原因：保持风格一致/)).toBeTruthy();
    expect(within(steer).getByText(/保留已完成工作/)).toBeTruthy();
    expect(screen.getByTestId("input-required-4").textContent).toContain("请确认输出目录");
    const result = screen.getByTestId("result-5");
    expect(within(result).getByText("已满足")).toBeTruthy();
    expect(within(result).getByText("已完成文档整理并输出清单")).toBeTruthy();

    // Artifacts：名称 + 哈希摘要 + 受控下载链接
    const artifacts = screen.getByTestId("subagent-artifacts");
    expect(within(artifacts).getByText("Artifacts（2）")).toBeTruthy();
    const link = within(artifacts).getByRole("link", { name: /下载 结果-1.md/ });
    expect(link.getAttribute("href")).toContain("/api/subagents/artifacts/saa_artifact1/content");
    expect(link.getAttribute("href")).toContain("ownerAgentId=agent-a");
    expect(within(artifacts).getAllByText(/01234567…/)).toHaveLength(2);
  });

  it("Run strip 切换只显示该 Run 的消息", async () => {
    const transcript = transcriptFixture({
      runs: [
        runRecord(1, "succeeded", { result: RESULT_OK }),
        runRecord(2, "running"),
      ],
      messages: [
        messageFixture(1, "task", { runId: "sar_run1", parts: [{ kind: "data", schema: "subagent.task_brief.v1", value: TASK_BRIEF }] }),
        messageFixture(2, "progress", { runId: "sar_run1" }),
        messageFixture(3, "progress", { runId: "sar_run2" }),
      ],
      nextMessageSequence: 3,
    });
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcript));
    renderPanel();
    await screen.findByTestId("subagent-task-brief");

    fireEvent.click(screen.getByTestId("run-tab-2"));
    expect(screen.queryByTestId("message-1")).toBeNull();
    expect(screen.queryByTestId("message-2")).toBeNull();
    expect(screen.getByTestId("message-3")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
    expect(screen.getByTestId("message-1")).toBeTruthy();
    expect(screen.getByTestId("message-2")).toBeTruthy();
  });

  it("SSE 流事件增量追加且按 seq 去重；snapshot 重建不重复", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()));
    renderPanel();
    await screen.findByTestId("subagent-task-brief");
    const stream = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

    // 实时 envelope（seq 6）：追加
    stream.emit("message", {
      seq: 6,
      threadId: THREAD_A,
      at: "2026-08-07T09:06:00.000Z",
      event: {
        kind: "message",
        message: messageFixture(6, "progress"),
      },
    }, "6");
    expect(await screen.findByTestId("message-6")).toBeTruthy();
    expect(screen.getAllByTestId("message-6")).toHaveLength(1);

    // 重复 seq（服务端不会发，防御）不重复追加
    stream.emit("message", {
      seq: 6,
      threadId: THREAD_A,
      at: "2026-08-07T09:06:00.000Z",
      event: { kind: "message", message: messageFixture(6, "progress") },
    }, "6");
    expect(screen.getAllByTestId("message-6")).toHaveLength(1);

    // stale cursor → reset + snapshot 重建基线（服务重启场景）
    const rebuilt = transcriptFixture({
      messages: [
        messageFixture(1, "task", { parts: [{ kind: "data", schema: "subagent.task_brief.v1", value: TASK_BRIEF }] }),
        messageFixture(2, "progress"),
        messageFixture(7, "progress"),
      ],
      nextMessageSequence: 7,
    });
    stream.emit("reset", { reason: "stream 已截断或服务重启，请以 snapshot 重建", lastSeq: 60 }, "60");
    stream.emit("snapshot", rebuilt, "60");
    expect(await screen.findByTestId("message-7")).toBeTruthy();
    // 重建后旧消息不重复（message-6 消失，message-2 仍只有一条）
    expect(screen.queryByTestId("message-6")).toBeNull();
    expect(screen.getAllByTestId("message-2")).toHaveLength(1);

    // snapshot 后到达的旧 seq（≤ snapshot 高水位）被去重，新 seq 追加
    stream.emit("message", {
      seq: 2,
      threadId: THREAD_A,
      at: "2026-08-07T09:07:00.000Z",
      event: { kind: "message", message: messageFixture(2, "progress") },
    }, "2");
    stream.emit("message", {
      seq: 62,
      threadId: THREAD_A,
      at: "2026-08-07T09:07:00.000Z",
      event: { kind: "message", message: messageFixture(62, "progress") },
    }, "62");
    expect(await screen.findByTestId("message-62")).toBeTruthy();
    expect(screen.getAllByTestId("message-2")).toHaveLength(1);
  });

  it("用户上滚后不强制回底，显示「有新内容」提示，点击后回底", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()));
    renderPanel();
    await screen.findByTestId("subagent-task-brief");
    const stream = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

    const scrollArea = screen.getByTestId("subagent-panel-scroll");
    // happy-dom 下 scrollTop 是只读访问器：只定义 scrollHeight/clientHeight，
    // 使 distance = 600 - 0 - 300 = 300 ≥ 24 → 视为用户已上滚
    Object.defineProperty(scrollArea, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(scrollArea, "clientHeight", { value: 300, configurable: true });
    fireEvent.scroll(scrollArea);

    stream.emit("message", {
      seq: 6,
      threadId: THREAD_A,
      at: "2026-08-07T09:06:00.000Z",
      event: { kind: "message", message: messageFixture(6, "progress") },
    }, "6");
    const pill = await screen.findByTestId("subagent-new-content");
    expect(pill.textContent).toContain("有新内容");

    fireEvent.click(pill);
    expect(screen.queryByTestId("subagent-new-content")).toBeNull();
  });

  it("关闭按钮触发 onClose", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()));
    const onClose = vi.fn();
    renderPanel({ onClose });
    await screen.findByText("整理项目文档");
    fireEvent.click(screen.getByTestId("subagent-panel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("移动端使用全屏只读 sheet（data-mobile）且无直接控制控件", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture()));
    renderPanel({ mobile: true });
    await screen.findByText("整理项目文档");
    const panel = screen.getByRole("region", { name: /Subagent 面板/ });
    expect(panel.getAttribute("data-mobile")).toBe("true");
    expect(screen.getByText("只读 · 不可直接控制")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /取消任务/ })).toBeNull();
  });

  it("Technical summary 展示 snapshot/工作区/预算/原因 与日志链接", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture({
      runs: [runRecord(1, "timed_out", { reasonCode: "subagent_run_timed_out", result: null })],
      messages: [messageFixture(1, "progress")],
      taskBrief: null,
    })));
    renderPanel();
    const summary = await screen.findByTestId("subagent-technical-summary");
    fireEvent.click(within(summary).getByText("技术信息"));
    expect(within(summary).getByText("sas_snap1")).toBeTruthy();
    expect(within(summary).getByText("read")).toBeTruthy();
    expect(within(summary).getByText(/迭代 24 · 工具 64 · Token 200000/)).toBeTruthy();
    expect(within(summary).getByText("subagent_run_timed_out")).toBeTruthy();
    expect(within(summary).getByText("C:\\ws")).toBeTruthy();
  });

  it("大段输出折叠并按需展开（§21.2）", async () => {
    const longText = "长".repeat(3_000);
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", transcriptFixture({
      messages: [messageFixture(1, "progress", { parts: [{ kind: "text", text: longText }] })],
      taskBrief: null,
    })));
    renderPanel();
    const block = await screen.findByTestId("message-1");
    expect(block.textContent).toContain("展开全文");
    expect(block.textContent).not.toContain("长长长".repeat(1000));
    fireEvent.click(within(block).getByRole("button", { name: "展开全文" }));
    expect(block.textContent).toContain("长".repeat(100));
    fireEvent.click(within(block).getByRole("button", { name: "收起" }));
    expect(block.textContent).toContain("展开全文");
  });

  it("请求失败时显示 error 状态", async () => {
    routes.push(route("/api/subagents/threads/sat_aaaaaaaaaaaa/transcript", {}, 500));
    renderPanel();
    const alert = await screen.findByTestId("subagent-panel-error");
    expect(alert).toBeTruthy();
  });
});

// ─── SubagentDefaultsSection（设置页默认模型）───────────────────

const FAKE_MODELS: readonly import("../../lib/types.js").ModelSummary[] = [
  { providerId: "faux", modelId: "faux-model", name: "Faux 模型", protocol: "faux", baseUrl: "", capabilities: { reasoning: false, input: ["text"] as const, contextWindow: 64000, maxTokens: 8192 }, credentialConfigured: true },
  { providerId: "openai", modelId: "gpt-4o", name: "GPT-4o", protocol: "openai", baseUrl: "", capabilities: { reasoning: false, input: ["text"] as const, contextWindow: 128000, maxTokens: 16384 }, credentialConfigured: false },
];

function fakePreferences(subagents?: { defaultModel: { providerId: string; modelId: string } | null }) {
  return {
    version: 1 as const,
    defaults: { model: null, thinkingLevel: "off" as const, toolMode: "off" as const },
    layout: { leftSidebarWidth: 240, rightSidebarWidth: 320, leftCollapsed: false, rightCollapsed: false, focusMode: false, reducedMotion: "system" as const },
    appearance: { theme: "dark" as const, showToolCalls: true, showThinking: true },
    ...(subagents !== undefined ? { subagents } : {}),
  };
}

describe("SubagentDefaultsSection", () => {
  it("默认选中「继承主 Agent」，保存 null（仅影响新建 Subagent）", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(
      <SubagentDefaultsSection
        preferences={fakePreferences({ defaultModel: null })}
        models={FAKE_MODELS}
        onSave={onSave}
        saving={false}
        lastSaveError={null}
      />,
    );
    const select = screen.getByLabelText("Subagent 默认模型") as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "保存 Subagent 默认模型" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ defaultModel: null }));
    expect(screen.getByText("仅影响新建 Subagent；已有 Subagent 不会中途换模型。")).toBeTruthy();
  });

  it("选择已配置模型并保存 { providerId, modelId }", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(
      <SubagentDefaultsSection
        preferences={fakePreferences({ defaultModel: null })}
        models={FAKE_MODELS}
        onSave={onSave}
        saving={false}
        lastSaveError={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("Subagent 默认模型"), { target: { value: "faux:faux-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Subagent 默认模型" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ defaultModel: { providerId: "faux", modelId: "faux-model" } }));
  });

  it("保存失败显示错误反馈", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("subagents.defaultModel 引用无效"));
    renderWithTheme(
      <SubagentDefaultsSection
        preferences={fakePreferences({ defaultModel: null })}
        models={FAKE_MODELS}
        onSave={onSave}
        saving={false}
        lastSaveError={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("Subagent 默认模型"), { target: { value: "faux:faux-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Subagent 默认模型" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("subagents.defaultModel 引用无效");
  });

  it("已有设置时回显当前默认模型", () => {
    renderWithTheme(
      <SubagentDefaultsSection
        preferences={fakePreferences({ defaultModel: { providerId: "faux", modelId: "faux-model" } })}
        models={FAKE_MODELS}
        onSave={vi.fn()}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect((screen.getByLabelText("Subagent 默认模型") as HTMLSelectElement).value).toBe("faux:faux-model");
  });
});
