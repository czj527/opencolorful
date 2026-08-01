import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryPage, maintenanceLabel } from "./MemoryPage.js";

/** 最小 EventSource 假实现：捕获实例以便手动触发 memory.agent.* 事件 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Array<(message: { data: string }) => void>>();
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (message: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}

  close(): void {}

  emit(type: string, payload: unknown): void {
    const message = { data: JSON.stringify(payload) };
    for (const handler of this.listeners.get(type) ?? []) handler(message);
  }
}

const defaultSettings = {
  enabled: true,
  utilityProviderId: null,
  utilityModel: null,
  deepDiveMode: "script",
  dailyRunTime: "03:00",
  minIdleMinutes: 30,
  weeklyReviewDay: 0,
  weeklyReviewTime: "03:30",
  turnsPerSummary: 10,
  injectBudgetChars: 2500,
  retentionThresholds: { mediumUp: 45, mediumDown: 35, permanentUp: 85 },
};

const payloads: Record<string, unknown> = {
  "/api/agents/agent-1/memory/compiled": {
    agentId: "agent-1",
    content: "## 重要事实\n重要事实\n",
    sections: { today: "今天完成了记忆页面", week: "本周摘要", longterm: "项目背景", facts: "重要事实" },
  },
  "/api/agents/agent-1/memory/facts": { facts: [{ id: 1, fact: "偏好简洁回复", tags: ["preference"] }] },
  "/api/agents/agent-1/memory/events": { events: [{ id: "event-1", startedAt: "2026-08-01T10:00:00Z", summary: "完成 UI" }] },
  "/api/agents/agent-1/memory/pinned": { pinned: [{ id: "pin-1", content: "Pinned note" }] },
  "/api/agents/agent-1/memory/health": { health: { recallEpisode: { status: "completed", resultCount: 2, layer: "facts" }, pendingBatches: 1 } },
  "/api/agents/agent-1/memory/timeline": {
    facts: [{ id: 1, fact: "时间线事实", retentionStrength: 60, activationStrength: 30, confidence: 0.9, status: "active", hitDates: 2 }],
    events: [{ id: "event-2", summary: "显著事件", date: "2026-07-30", salience: 80 }],
  },
  "/api/agents/agent-1/memory/settings": { settings: defaultSettings },
  "/api/agents/agent-1/memory/runs/run_abc": { run: { runId: "run_abc", status: "completed" }, report: "# 整理报告\n- create_fact 已应用\n" },
};

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    eventId: `evt-${Math.random()}`,
    sessionId: null,
    streamId: "agent:agent-1",
    sequence: 1,
    timestamp: "2026-08-01T12:00:00.000Z",
    type,
    payload,
  };
}

describe("maintenanceLabel 状态文案（plan §8.3）", () => {
  it("映射整理状态为中文阶段文案", () => {
    expect(maintenanceLabel("queued")).toBe("已排队");
    expect(maintenanceLabel("started")).toBe("正在整理往事");
    expect(maintenanceLabel("processing")).toBe("正在核对记忆");
    expect(maintenanceLabel("processing", "策略审批")).toBe("正在合并相近记忆");
    expect(maintenanceLabel("completed")).toBe("整理完成");
    expect(maintenanceLabel("deferred")).toBe("整理延期");
    expect(maintenanceLabel("failed")).toBe("整理失败");
  });
});

describe("MemoryPage", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const path = url.pathname;
      if (path === "/api/agents") return new Response(JSON.stringify({ agents: [{ identity: { id: "agent-1", name: "Hanako" } }] }), { status: 200 });
      const method = init?.method ?? "GET";
      if (method === "POST" && path.endsWith("/memory/deep-dive")) {
        return new Response(JSON.stringify({ agentId: "agent-1", status: "queued" }), { status: 202 });
      }
      if (method === "PUT" && path.endsWith("/memory/settings")) {
        return new Response(JSON.stringify({ agentId: "agent-1", settings: JSON.parse(String(init?.body)) }), { status: 200 });
      }
      return new Response(JSON.stringify(payloads[path] ?? {}), { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows compiled sections, facts, timeline and health", async () => {
    render(<MemoryPage />);
    expect(await screen.findByText("今天完成了记忆页面")).toBeTruthy();
    expect(screen.getByText("偏好简洁回复")).toBeTruthy();
    expect(screen.getByText("完成 UI")).toBeTruthy();
    expect(screen.getByText("Pinned note")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("Pending batch")).toBeTruthy();
  });

  it("filters read-only content with the search box", async () => {
    render(<MemoryPage />);
    await screen.findByText("完成 UI");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "偏好" } });
    await waitFor(() => expect(screen.getByText("偏好简洁回复")).toBeTruthy());
    expect(screen.queryByText("完成 UI")).toBeNull();
  });

  it("shows strength timeline with retention/activation breakdown and salience", async () => {
    render(<MemoryPage />);
    expect(await screen.findByText("强度时间线")).toBeTruthy();
    // 等待时间线数据到达（与 heading 同一批次渲染，但保留等待以消除调度竞态）
    expect(await screen.findByText("时间线事实")).toBeTruthy();
    const strengthSection = within(screen.getByLabelText("时间线事实强度"));
    // 双强度分解：retention 60 / activation 30
    expect(strengthSection.getByText("60")).toBeTruthy();
    expect(strengthSection.getByText("30")).toBeTruthy();
    expect(strengthSection.getByText("2 个回想日")).toBeTruthy();
    // 事件显著度
    expect(screen.getByText("显著事件")).toBeTruthy();
    expect(screen.getByText("80")).toBeTruthy();
  });

  it("tracks background maintenance via memory.agent.* SSE events", async () => {
    render(<MemoryPage />);
    await screen.findByText("今天完成了记忆页面");
    const sse = FakeEventSource.instances[0];
    expect(sse).toBeDefined();
    if (sse === undefined) throw new Error("SSE 连接未建立");

    sse.emit("memory.agent.started", envelope("memory.agent.started", { runId: "run_abc", agentId: "agent-1", status: "started", phase: "提取候选" }));
    expect((await screen.findAllByText("正在整理往事")).length).toBeGreaterThan(0);

    sse.emit("memory.agent.processing", envelope("memory.agent.processing", { runId: "run_abc", agentId: "agent-1", status: "processing", phase: "记忆 Agent 整理" }));
    expect((await screen.findAllByText("正在核对记忆")).length).toBeGreaterThan(0);

    sse.emit("memory.agent.processing", envelope("memory.agent.processing", { runId: "run_abc", agentId: "agent-1", status: "processing", phase: "策略审批" }));
    expect((await screen.findAllByText("正在合并相近记忆")).length).toBeGreaterThan(0);

    sse.emit("memory.agent.completed", envelope("memory.agent.completed", { runId: "run_abc", agentId: "agent-1", status: "completed", phase: "整理完成" }));
    expect((await screen.findAllByText("整理完成")).length).toBeGreaterThan(0);
    // completed 后自动拉取脱敏运行报告
    await waitFor(() => expect(screen.getByText("最近运行报告（脱敏）")).toBeTruthy());
    expect(screen.getByText(/create_fact 已应用/)).toBeTruthy();
  });

  it("queues a deep-dive run and shows 已排队", async () => {
    render(<MemoryPage />);
    await screen.findByText("今天完成了记忆页面");
    fireEvent.click(screen.getByRole("button", { name: /立即整理/ }));
    expect((await screen.findAllByText("已排队")).length).toBeGreaterThan(0);
  });

  it("loads and saves per-agent memory settings", async () => {
    render(<MemoryPage />);
    await screen.findByText("今天完成了记忆页面");
    // 表单回显默认值
    const daily = screen.getByLabelText("每日整理时间") as HTMLInputElement;
    expect(daily.value).toBe("03:00");

    fireEvent.change(daily, { target: { value: "05:00" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    const fetchMock = vi.mocked(fetch);
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).endsWith("/api/agents/agent-1/memory/settings") && init?.method === "PUT");
      expect(putCall).toBeTruthy();
      expect(String(putCall![1]?.body)).toContain('"dailyRunTime":"05:00"');
    });
    expect(await screen.findByText(/已保存/)).toBeTruthy();
  });
});
