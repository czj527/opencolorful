import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiClient } from "../../lib/api-client.js";
import type {
  ActivityPage,
  ActivityRow,
  ObservabilityHealthResponse,
  TraceResponse,
} from "../../lib/types.js";
import { LogsPage } from "./LogsPage.js";
import { renderWithTheme } from "../../test/render.js";

// ─── fetch mock：按 URL 路由到 fixture 响应 ─────────────────────

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

function throwRoute(prefix: string): FetchRoute {
  return {
    match: (url) => url.startsWith(prefix),
    handler: () => { throw new Error("网络不可用"); },
  };
}

function activityRequests(): string[] {
  return mockFetch.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/observability/activity"));
}

beforeEach(() => {
  routes = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const item of routes) {
      if (item.match(url)) return item.handler(url);
    }
    throw new Error(`测试中未预期的请求: ${url}`);
  });
});

// ─── fixtures ───────────────────────────────────────────────────

const HEALTH_OK: ObservabilityHealthResponse = {
  status: "ok",
  logger: { dropped: 0, failed: 0, degraded: false, disk: { totalBytes: 1000, debugBytes: 400, mainBytes: 600 } },
  spool: { failedWrites: 0, pendingSegments: 0, totalBytes: 0 },
  auditEpoch: 3,
  recovery: { lastInterrupted: 0, lastSpoolImported: 0 },
};

function activityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    eventId: "evt-1",
    recordedAt: "2026-08-01T10:00:00.000Z",
    occurredAt: "2026-08-01T10:00:00.000Z",
    eventName: "system.started",
    category: "system",
    level: "info",
    status: "completed",
    significance: "notable",
    actorKind: "system",
    actorId: "agent-server",
    executorKind: "service",
    executorId: "agent-server",
    targetKind: "platform",
    targetId: "agent-server",
    ownerAgentId: null,
    sessionId: null,
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: null,
    operationId: null,
    durationMs: 12,
    errorCode: null,
    retryable: 0,
    producerComponent: "agent-server",
    producerProcessType: "server",
    payloadJson: JSON.stringify({ summaryCode: "system_started" }),
    ...overrides,
  };
}

function activityPage(rows: readonly ActivityRow[], nextCursor: string | null = null): ActivityPage {
  return { items: rows, nextCursor };
}

function renderPage(extraRoutes: FetchRoute[]): void {
  routes.push(route("/api/observability/health", HEALTH_OK), ...extraRoutes);
  renderWithTheme(<LogsPage api={new ApiClient("")} />);
}

// ─── 测试 ───────────────────────────────────────────────────────

describe("LogsPage 活动 tab", () => {
  it("加载并渲染活动行", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([activityRow()])),
    ]);

    expect(await screen.findByText("system.started")).toBeTruthy();
    expect(screen.getByTestId("activity-row-1")).toBeTruthy();
    expect(within(screen.getByTestId("activity-row-1")).getByText("completed")).toBeTruthy();
  });

  it("空数据时显示 empty 状态", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
    ]);

    expect(await screen.findByText("暂无活动事件")).toBeTruthy();
  });

  it("请求失败时显示 error 状态与重试按钮", async () => {
    routes.push(
      throwRoute("/api/observability/health"),
      throwRoute("/api/observability/activity"),
    );
    renderWithTheme(<LogsPage api={new ApiClient("")} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("网络不可用");
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    // health 不可用 → 顶部 degraded 徽标
    expect(await screen.findByText("健康不可用")).toBeTruthy();
  });

  it("应用过滤后按参数拼装查询", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([activityRow()])),
    ]);
    await screen.findByText("system.started");

    fireEvent.change(screen.getByLabelText("事件名过滤"), { target: { value: "turn.failed" } });
    fireEvent.change(screen.getByLabelText("类别过滤"), { target: { value: "turn" } });
    fireEvent.change(screen.getByLabelText("级别过滤"), { target: { value: "error" } });
    fireEvent.change(screen.getByLabelText("全文搜索"), { target: { value: "provider" } });
    fireEvent.click(screen.getByRole("button", { name: "应用过滤" }));

    await waitFor(() => {
      const request = activityRequests().at(-1);
      expect(request).toBeDefined();
      const params = new URLSearchParams(request!.split("?")[1] ?? "");
      expect(params.get("eventName")).toBe("turn.failed");
      expect(params.get("category")).toBe("turn");
      expect(params.get("level")).toBe("error");
      expect(params.get("search")).toBe("provider");
      expect(params.get("limit")).toBe("50");
    });
  });

  it("行点击打开详情面板并可查看 trace 树", async () => {
    const traceResponse: TraceResponse = {
      trace: {
        root: {
          id: 1,
          spanId: "span-1",
          parentSpanId: null,
          eventName: "system.started",
          status: "completed",
          recordedAt: "2026-08-01T10:00:00.000Z",
          durationMs: 12,
          operationId: null,
          children: [
            {
              id: 2,
              spanId: "span-2",
              parentSpanId: "span-1",
              eventName: "storage.database.opened",
              status: "completed",
              recordedAt: "2026-08-01T10:00:00.001Z",
              durationMs: 3,
              operationId: null,
              children: [],
            },
          ],
        },
        total: 2,
      },
      linked: {
        rootTraceId: "trace-1",
        nodes: [{ traceId: "trace-2", relation: "linked", direction: "forward" }],
        truncated: false,
        maxDepth: 4,
        maxNodes: 50,
      },
    };

    renderPage([
      route("/api/observability/activity", activityPage([activityRow()])),
      route("/api/observability/traces/trace-1", traceResponse),
    ]);
    await screen.findByText("system.started");

    fireEvent.click(screen.getByTestId("activity-row-1"));
    expect(screen.getByTestId("activity-detail")).toBeTruthy();
    expect(screen.getByText("system:agent-server")).toBeTruthy(); // actor
    // 时长同时出现在表格列与详情网格中
    expect(screen.getAllByText("12 ms").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: /查看 trace 树/ }));
    expect(await screen.findByTestId("trace-panel")).toBeTruthy();
    expect(screen.getByText("storage.database.opened")).toBeTruthy();
    expect(screen.getByText(/共 2 个 span/)).toBeTruthy();
    expect(screen.getByText("trace-2")).toBeTruthy(); // linked graph 节点
  });

  it("开启实时跟随后通过 EventSource 收到新行并 prepend", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly url: string;
      private readonly handlers = new Map<string, Array<(event: { data: string | undefined }) => void>>();
      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, handler: (event: { data: string | undefined }) => void): void {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
      }
      emit(type: string, data?: string): void {
        for (const handler of this.handlers.get(type) ?? []) handler({ data });
      }
      close(): void {
        this.closed = true;
      }
      closed = false;
    }
    vi.stubGlobal("EventSource", FakeEventSource);

    renderPage([
      route("/api/observability/activity", activityPage([activityRow()])),
    ]);
    await screen.findByText("system.started");

    fireEvent.click(screen.getByLabelText("实时跟随"));
    const source = FakeEventSource.instances.at(-1);
    expect(source).toBeDefined();
    expect(source!.url).toContain("sinceId=1");
    source!.emit("open");
    expect(await screen.findByText(/跟随中/)).toBeTruthy();

    source!.emit("activity", JSON.stringify(activityRow({
      id: 2,
      eventId: "evt-2",
      eventName: "turn.completed",
      recordedAt: "2026-08-01T10:00:01.000Z",
    })));
    expect(await screen.findByText("turn.completed")).toBeTruthy();
    // 新行 prepend 到列表顶部：出现在第一行
    const rows = screen.getAllByTestId(/^activity-row-/);
    expect(rows[0]?.getAttribute("data-testid")).toBe("activity-row-2");

    // 关闭后 EventSource 关闭
    fireEvent.click(screen.getByLabelText("实时跟随"));
    expect(source!.closed).toBe(true);
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });
});

describe("LogsPage 错误 tab", () => {
  it("渲染错误分组并可展开最近样例", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
      route("/api/observability/errors", {
        items: [
          {
            eventName: "model.call.failed",
            errorCode: "RATE_LIMIT",
            count: 3,
            lastRecordedAt: "2026-08-01T09:00:00.000Z",
          },
        ],
      }),
    ]);
    await screen.findByText(/暂无活动事件/);

    fireEvent.click(screen.getByTestId("logs-tab-errors"));
    expect(await screen.findByText("model.call.failed")).toBeTruthy();
    expect(screen.getByText("RATE_LIMIT")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();

    // 展开样例：调 activity?eventName=...&errorCode=...
    routes.push(route("/api/observability/activity?eventName=model.call.failed&errorCode=RATE_LIMIT",
      activityPage([activityRow({ id: 9, eventName: "model.call.failed", errorCode: "RATE_LIMIT", level: "error", status: "failed" })], null)));
    fireEvent.click(screen.getByRole("button", { name: /查看 model.call.failed 最近样例/ }));
    expect(await screen.findByTestId("error-samples")).toBeTruthy();
    const sampleRequest = activityRequests().at(-1);
    expect(sampleRequest).toContain("eventName=model.call.failed");
    expect(sampleRequest).toContain("errorCode=RATE_LIMIT");
  });
});

describe("LogsPage 安全审计 tab", () => {
  it("渲染审计表格并支持 epoch 过滤", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
      route("/api/observability/audit", {
        items: [
          {
            id: 1,
            eventId: "audit-1",
            ledgerEpoch: 3,
            recordedAt: "2026-08-01T08:00:00.000Z",
            eventName: "audit.sandbox.path_denied",
            action: "sandbox.path.denied",
            decision: "denied",
            reasonCode: "protected",
            actorKind: "agent",
            actorId: "agent-a",
            ownerAgentId: "agent-a",
            sessionId: null,
            traceId: "trace-1",
            operationId: "operation-1",
            payloadJson: JSON.stringify({ action: "sandbox.path.denied", decision: "denied" }),
          },
        ],
        nextCursor: null,
      }),
    ]);
    await screen.findByText(/暂无活动事件/);

    fireEvent.click(screen.getByTestId("logs-tab-audit"));
    expect(await screen.findByText("audit.sandbox.path_denied")).toBeTruthy();
    expect(await screen.findByText("sandbox.path.denied")).toBeTruthy();
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.getByText("agent:agent-a")).toBeTruthy();

    // epoch 下拉来自 health.auditEpoch=3
    const epochSelect = screen.getByLabelText("Epoch 过滤") as HTMLSelectElement;
    fireEvent.change(epochSelect, { target: { value: "3" } });
    await waitFor(() => {
      const auditRequests = mockFetch.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith("/api/observability/audit"));
      const auditRequest = auditRequests.at(-1);
      expect(auditRequest).toBeDefined();
      expect(auditRequest).toContain("epoch=3");
    });

    fireEvent.click(screen.getByText("audit.sandbox.path_denied"));
    expect(await screen.findByTestId("audit-detail")).toBeTruthy();
    expect(screen.getByText("operation-1")).toBeTruthy();

    await new ApiClient("").queryAudit({
      eventName: "audit.sandbox.path_denied",
      operationId: "operation-1",
    });
    const lifecycleRequest = mockFetch.mock.calls.map((call) => String(call[0])).at(-1);
    expect(lifecycleRequest).toContain("eventName=audit.sandbox.path_denied");
    expect(lifecycleRequest).toContain("operationId=operation-1");
  });
});

describe("LogsPage 性能 tab", () => {
  it("渲染按日指标与柱状条", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
      route("/api/observability/metrics?days=7", {
        items: [
          {
            date: "2026-07-31",
            eventCount: 40,
            errorCount: 2,
            failedCount: 1,
            degradedCount: 0,
            byLevel: { info: 38, error: 2 },
          },
        ],
      }),
    ]);
    await screen.findByText(/暂无活动事件/);

    fireEvent.click(screen.getByTestId("logs-tab-performance"));
    expect(await screen.findByTestId("metric-list")).toBeTruthy();
    expect(screen.getByText("2026-07-31")).toBeTruthy();
    expect(screen.getByText("error 2 · failed 1 · degraded 0")).toBeTruthy();
  });
});

describe("LogsPage 原始日志 tab", () => {
  it("选择进程/文件/行数并加载 tail 渲染", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
      route("/api/observability/diagnostic/tail", {
        process: "server",
        file: "2026-08-01_abc_main.jsonl",
        lines: 2,
        totalBytes: 1024,
        tail: ['{"event":"a"}', '{"event":"b"}'],
      }),
    ]);
    await screen.findByText(/暂无活动事件/);

    fireEvent.click(screen.getByTestId("logs-tab-raw"));
    fireEvent.click(screen.getByRole("button", { name: /加载/ }));

    const viewer = await screen.findByTestId("log-viewer");
    expect(viewer.textContent).toContain('{"event":"a"}');
    expect(viewer.textContent).toContain('{"event":"b"}');
    // 元信息：不整文件加载，只展示行数与字节
    expect(screen.getByTestId("tail-meta").textContent).toContain("2 行");
    expect(screen.getByTestId("tail-meta").textContent).toContain("1.0 KB");
  });
});

describe("LogsPage 诊断导出 tab", () => {
  it("生成导出在端点未实现时显示 T9 pending 状态", async () => {
    renderPage([
      route("/api/observability/activity", activityPage([])),
      route("/api/observability/export", { code: "NOT_FOUND", message: "导出未实现" }, 404),
    ]);
    await screen.findByText(/暂无活动事件/);

    fireEvent.click(screen.getByTestId("logs-tab-export"));
    await screen.findByRole("button", { name: /生成导出/ });
    fireEvent.click(screen.getByRole("button", { name: /生成导出/ }));

    expect(await screen.findByText(/导出功能即将提供（T9）/)).toBeTruthy();
    // health 摘要卡片随页面 health 渲染
    expect(screen.getByTestId("health-summary-card")).toBeTruthy();
  });
});

describe("LogsPage health 徽标", () => {
  it("logger 降级 / spool pending / 事件丢弃时显示对应徽标", async () => {
    routes.push(route("/api/observability/health", {
      status: "ok",
      logger: { dropped: 5, failed: 0, degraded: true, disk: { totalBytes: 1000, debugBytes: 400, mainBytes: 600 } },
      spool: { failedWrites: 0, pendingSegments: 2, totalBytes: 300 },
      auditEpoch: 3,
      recovery: { lastInterrupted: 0, lastSpoolImported: 0 },
    }));
    routes.push(route("/api/observability/activity", activityPage([])));
    renderWithTheme(<LogsPage api={new ApiClient("")} />);

    expect(await screen.findByText("logger 降级")).toBeTruthy();
    expect(screen.getByText("事件丢弃 5")).toBeTruthy();
    expect(screen.getByText("spool 待处理 2")).toBeTruthy();
    expect(screen.getByText("Epoch 3")).toBeTruthy();
  });

  it("health 不可用（503）时显示 degraded 徽标", async () => {
    routes.push(route("/api/observability/health", { status: "unavailable" }, 503));
    routes.push(route("/api/observability/activity", activityPage([])));
    renderWithTheme(<LogsPage api={new ApiClient("")} />);

    expect(await screen.findByText("健康不可用")).toBeTruthy();
  });
});

describe("LogsPage 复审修复（评审 P1-11 复现级测试）", () => {
  it("实时跟随应用当前活动筛选：不匹配 live 行不进列表，匹配行 prepend", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly url: string;
      private readonly handlers = new Map<string, Array<(event: { data: string | undefined }) => void>>();
      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, handler: (event: { data: string | undefined }) => void): void {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
      }
      emit(type: string, data?: string): void {
        for (const handler of this.handlers.get(type) ?? []) handler({ data });
      }
      close(): void { this.closed = true; }
      closed = false;
    }
    vi.stubGlobal("EventSource", FakeEventSource);

    renderPage([
      route("/api/observability/activity", activityPage([activityRow()])),
    ]);
    await screen.findByText("system.started");

    // 应用筛选：事件名 = system.started
    fireEvent.change(screen.getByLabelText("事件名过滤"), { target: { value: "system.started" } });
    fireEvent.click(screen.getByRole("button", { name: "应用过滤" }));
    // 等待过滤后的 reload 完成（items 先清空再回填），避免异步 fetch 覆盖 live prepend
    await screen.findByText("system.started");

    fireEvent.click(screen.getByLabelText("实时跟随"));
    const source = FakeEventSource.instances.at(-1);
    expect(source).toBeDefined();

    // live 行不匹配筛选（turn.completed）→ 不进列表
    source!.emit("activity", JSON.stringify(activityRow({
      id: 2,
      eventId: "evt-2",
      eventName: "turn.completed",
      recordedAt: "2026-08-01T10:00:01.000Z",
    })));
    expect(screen.queryByText("turn.completed")).toBeNull();

    // live 行匹配筛选（system.started）→ prepend
    source!.emit("activity", JSON.stringify(activityRow({
      id: 3,
      eventId: "evt-3",
      recordedAt: "2026-08-01T10:00:02.000Z",
    })));
    // 等待匹配行进入列表（避免与既有行同文本导致断言提前通过）
    await screen.findByTestId("activity-row-3");
    const rows = screen.getAllByTestId(/^activity-row-/);
    expect(rows[0]?.getAttribute("data-testid")).toBe("activity-row-3");

    fireEvent.click(screen.getByLabelText("实时跟随"));
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });
});
