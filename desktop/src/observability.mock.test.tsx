/**
 * L5 · OBS-01（日志页三 tab + 健康 badge）+ OBS-02（活动过滤/分页/实时跟随）
 * Mock 渲染层回归。生产 MockDataSource（fixtures 对齐 /api/observability/* 响应形状）；
 * OBS-02 的分页与 SSE 推送经 overrideSource 注入（A4f lane 本地脚本，不改共享 fixture）。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { LogsPage } from "./pages/LogsPage.js";
import { MockDataSource } from "./data/mock-source.js";
import { activityLogs, type ActivityLogRow } from "./mock-data.js";
import type { ActivityFilter } from "./data/source.js";
import { trackConsoleErrors } from "../tests/fixtures/console.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeLogsPagePO } from "../tests/fixtures/pages/logs.js";

it("OBS-01: 日志页三 tab（活动/错误/安全审计）+ 健康 badge 渲染", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<LogsPage source={new MockDataSource()} />);
    const po = makeLogsPagePO(user);
    await po.ready();

    // 健康 badge：logger.failed=1、spool=2、epoch=4、disk=183MB；未降级/无丢弃则不渲染
    expect(po.healthBadge("写入失败 1")).not.toBeNull();
    expect(po.healthBadge("spool 待处理 2")).not.toBeNull();
    expect(po.healthBadge("Epoch 4")).not.toBeNull();
    expect(po.healthBadge("磁盘 183 MB")).not.toBeNull();
    expect(po.healthBadge("logger 降级")).toBeNull();
    expect(po.healthBadge("事件丢弃")).toBeNull();

    // 活动 tab：默认视图
    expect(screen.getByText("session.prompt.accepted")).toBeTruthy();

    // 错误 tab：分组与错误码
    await po.switchTab("错误");
    expect(screen.getByText("tool.failed")).toBeTruthy();
    expect(screen.getByText("PATTERN_TOO_BROAD")).toBeTruthy();

    // 安全审计 tab：账本行 + Epoch 过滤（只读）
    await po.switchTab("安全审计");
    expect(screen.getByText("sandbox.write.granted")).toBeTruthy();
    expect(screen.getAllByText("allowed").length).toBe(2);
    expect(screen.getByRole("combobox", { name: "Epoch 过滤" })).toBeTruthy();
    expect(screen.getByText("审计账本只读，无编辑或删除入口。")).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("OBS-01: 日志加载失败 → errors.ts 兜底中文错误 + 重试入口", async () => {
  const tracker = trackConsoleErrors();
  const base = new MockDataSource();
  const source = overrideSource(base, {
    getLogsData: () => Promise.reject(new Error("日志服务离线")),
  });
  try {
    render(<LogsPage source={source} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("日志加载失败，请重试。");
    expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

/* ---------------------------------------------------------------------------
 * A4f lane 本地工具（仅本文件使用，不改共享 fixture）：
 * - activityTableRows：读取活动表 body 行文本（首行为表头，slice 掉），
 *   供「列表只剩匹配行」与「新行置顶/追加」断言。
 * - pushActivityRow：A4d MAGENT-01 的 maintenanceHandlers Set 模式套用到
 *   activity 流——overrideSource 把 subscribeActivityStream 的 handler 收进
 *   本地 Set，测试按脚本向集合广播（生产 Mock 该方法不产生实时日志）。
 * ------------------------------------------------------------------------- */

function activityTableRows(): readonly string[] {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
}

function pushActivityRow(
  handlers: ReadonlySet<(row: ActivityLogRow) => void>,
  row: ActivityLogRow,
): void {
  for (const handler of handlers) handler(row);
}

function makeLiveActivityRow(id: number, eventName: string): ActivityLogRow {
  return {
    id,
    recordedAt: "2026-08-20T10:50:00+08:00",
    eventName,
    level: "info",
    status: "completed",
    category: "turn",
    producerComponent: "TurnService",
    durationMs: 42,
    sessionId: "desktop",
    ownerAgentId: "yuan",
    traceId: `tr-a4f-live-${id}`,
    payloadPreview: "{ turn: live }",
  };
}

it("OBS-02: 活动页过滤——类别/级别/状态/搜索关键字各自生效，列表只剩匹配行", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<LogsPage source={new MockDataSource()} />);
    await screen.findByText("session.prompt.accepted");
    expect(activityTableRows()).toHaveLength(activityLogs.length);

    // 类别过滤：memory → 只剩 2 条记忆事件
    await user.selectOptions(screen.getByRole("combobox", { name: "类别过滤" }), "memory");
    await waitFor(() => {
      expect(activityTableRows()).toHaveLength(2);
    });
    expect(screen.getByText("memory.recall.completed")).toBeTruthy();
    expect(screen.getByText("memory.sealed_batch.pending")).toBeTruthy();
    expect(screen.queryByText("session.prompt.accepted")).toBeNull();

    // 级别过滤（重置类别）：warn → retrying + deferred 两条
    await user.selectOptions(screen.getByRole("combobox", { name: "类别过滤" }), screen.getByRole("option", { name: "全部类别" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "级别过滤" }), "warn");
    await waitFor(() => {
      expect(activityTableRows()).toHaveLength(2);
    });
    expect(screen.getByText("provider.request.retrying")).toBeTruthy();
    expect(screen.getByText("memory.sealed_batch.pending")).toBeTruthy();
    expect(screen.queryByText("tool.failed")).toBeNull();

    // 状态过滤（重置级别）：retrying → 仅 1 条
    await user.selectOptions(screen.getByRole("combobox", { name: "级别过滤" }), screen.getByRole("option", { name: "全部级别" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "状态过滤" }), "retrying");
    await waitFor(() => {
      expect(activityTableRows()).toHaveLength(1);
    });
    expect(screen.getByText("provider.request.retrying")).toBeTruthy();
    expect(screen.queryByText("memory.sealed_batch.pending")).toBeNull();

    // 搜索关键字（重置状态）：eventName 命中 subagent → 2 条（经 300ms 防抖重查）
    await user.selectOptions(screen.getByRole("combobox", { name: "状态过滤" }), screen.getByRole("option", { name: "全部状态" }));
    await user.type(screen.getByPlaceholderText("事件名 / 组件"), "subagent");
    await waitFor(() => {
      expect(activityTableRows()).toHaveLength(2);
    });
    expect(screen.getByText("subagent.run.succeeded")).toBeTruthy();
    expect(screen.getByText("subagent.spawn.completed")).toBeTruthy();
    expect(screen.queryByText("session.prompt.accepted")).toBeNull();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("OBS-02: 加载更多分页——mock cursor 两页数据经「加载更多」追加，取尽后按钮消失", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  const page1 = activityLogs.slice(0, 3);
  const page2 = activityLogs.slice(3, 6);
  const calls: { filter: ActivityFilter; cursor: string | null }[] = [];
  const source = overrideSource(new MockDataSource(), {
    queryActivity: (filter: ActivityFilter, cursor?: string | null) => {
      calls.push({ filter, cursor: cursor ?? null });
      return cursor === null || cursor === undefined
        ? Promise.resolve({ rows: page1, nextCursor: "cursor-a4f-page2" })
        : Promise.resolve({ rows: page2, nextCursor: null });
    },
  });
  try {
    render(<LogsPage source={source} />);
    await screen.findByText("session.prompt.accepted");
    expect(activityTableRows()).toHaveLength(3);
    expect(screen.queryByText("provider.request.retrying")).toBeNull();
    expect(screen.getByRole("button", { name: "加载更多" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "加载更多" }));

    // 追加语义：第二页接在第一页之后；nextCursor=null 后按钮消失
    await waitFor(() => {
      expect(activityTableRows()).toHaveLength(6);
    });
    const rows = activityTableRows();
    expect(rows[0]).toContain("session.prompt.accepted");
    expect(rows[3]).toContain("provider.request.retrying");
    expect(rows[5]).toContain("tool.failed");
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();

    // 分页链路：首查无 cursor，翻页携带上一页 nextCursor 与同一过滤条件
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cursor).toBeNull();
    expect(calls[1]?.cursor).toBe("cursor-a4f-page2");
    expect(calls[1]?.filter).toEqual({});
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("OBS-02: 实时跟随——开关开启时 activity 流推送追加新行（置顶 + 计数），关闭后不再追加", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  const streamHandlers = new Set<(row: ActivityLogRow) => void>();
  const source = overrideSource(new MockDataSource(), {
    subscribeActivityStream: (handler: (row: ActivityLogRow) => void) => {
      streamHandlers.add(handler);
      return () => {
        streamHandlers.delete(handler);
      };
    },
  });
  try {
    render(<LogsPage source={source} />);
    await screen.findByText("session.prompt.accepted");

    const followSwitch = () => screen.getByRole("switch", { name: "实时跟随开关" });
    expect(followSwitch().getAttribute("aria-checked")).toBe("false");

    // 关闭态（初始）：订阅未建立，推送不追加
    await act(async () => {
      pushActivityRow(streamHandlers, makeLiveActivityRow(200, "session.turn.completed"));
    });
    expect(screen.queryByText("session.turn.completed")).toBeNull();

    // 开启：推送即追加——新行置顶，live 计数 badge 递增
    await user.click(followSwitch());
    expect(followSwitch().getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      pushActivityRow(streamHandlers, makeLiveActivityRow(200, "session.turn.completed"));
    });
    expect(screen.getByText("session.turn.completed")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    await act(async () => {
      pushActivityRow(streamHandlers, makeLiveActivityRow(201, "session.turn.started"));
    });
    expect(screen.getByText("+2")).toBeTruthy();
    expect(activityTableRows()[0]).toContain("session.turn.started");

    // 关闭：cleanup 从 handler 集合移除（unsub），推送不再追加，既有行保留
    await user.click(followSwitch());
    expect(followSwitch().getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      pushActivityRow(streamHandlers, makeLiveActivityRow(202, "session.turn.failed"));
    });
    expect(screen.queryByText("session.turn.failed")).toBeNull();
    expect(screen.getByText("session.turn.completed")).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});
