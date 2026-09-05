/**
 * L5 · MEM-01/02/03（记忆页加载/搜索/置顶）Mock 渲染层回归。
 * MEM-01/03 用生产 MockDataSource；MEM-02 注入"服务端 q= 过滤"行为（fixture 注入表）——
 * 生产 MockDataSource.getMemoryData 忽略 query 参数，属 wire-shape parity 缺口（见任务报告）。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { MemoryPage } from "./pages/MemoryPage.js";
import { MockDataSource } from "./data/mock-source.js";
import { agents } from "./mock-data.js";
import type { MemoryPageData } from "./data/source.js";
import { trackConsoleErrors } from "../tests/fixtures/console.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeMemoryPagePO } from "../tests/fixtures/pages/memory.js";

const agent = agents[0] ?? {
  id: "yuan", name: "原", initial: "原", color: "#3aa96c", description: "",
};

it("MEM-01: 记忆页四段编译制品 / 事实 / 事件 / 健康状态渲染（含 loading 态）", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<MemoryPage source={new MockDataSource()} agent={agent} agents={agents} onAgent={() => undefined} />);
    const po = makeMemoryPagePO(user);

    expect(screen.getByText("正在加载记忆…")).toBeTruthy(); // loading 态先渲染
    await po.ready();

    expect(po.sectionHeading(/^编译记忆/)).toBeTruthy();
    const todayBlock = screen.getByText("今天").closest("details");
    expect(todayBlock?.textContent).toContain("桌面原型评审");
    for (const label of ["今天", "本周", "长期", "重要事实"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(within(screen.getByLabelText("记忆健康状态")).getByText("completed")).toBeTruthy();
    expect(po.pinnedItems()).toHaveLength(2);
    expect(po.factCount()).toBe(3);
    expect(po.eventCount()).toBe(3);
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("MEM-01: 加载失败 → role=alert 中文错误 + 重试入口", async () => {
  const tracker = trackConsoleErrors();
  const base = new MockDataSource();
  const source = overrideSource(base, {
    getMemoryData: () => Promise.reject(new Error("记忆服务不可达")),
  });
  try {
    render(<MemoryPage source={source} agent={agent} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("记忆服务不可达");
    expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("MEM-02: 关键字搜索经 400ms 防抖后按 q 过滤事实与事件（fixture 注入服务端 q 行为）", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  const base = new MockDataSource();
  // parity 记录：生产 MockDataSource.getMemoryData 签名不含 (agentId, query?) 参数（见任务报告缺口表）
  const basePage: MemoryPageData = await base.getMemoryData();
  const querySpy = vi.fn<(agentId: string, query?: string) => void>();
  const source = overrideSource(base, {
    getMemoryData: (requestedAgentId: string, query?: string) => {
      const keyword = (query ?? "").trim();
      querySpy(requestedAgentId, query);
      return Promise.resolve<MemoryPageData>({
        ...basePage,
        facts: keyword === ""
          ? basePage.facts
          : basePage.facts.filter((fact) =>
            fact.fact.includes(keyword) || fact.tags.some((tag) => tag.includes(keyword))),
        events: keyword === ""
          ? basePage.events
          : basePage.events.filter((event) =>
            event.summary.includes(keyword) || event.topics.some((topic) => topic.includes(keyword))),
      });
    },
  });
  try {
    render(<MemoryPage source={source} agent={agent} />);
    const po = makeMemoryPagePO(user);
    await po.ready();
    expect(po.factCount()).toBe(3);

    await po.search("沙箱");

    // 防抖 + 重新查询后：仅命中的事实保留（限定在事实 section 内断言，
    // 编译制品「长期」块文本与事实内容有交集，不能全屏匹配）
    const factsSection = po.section(/^已审批事实/);
    await waitFor(() => {
      expect(po.factCount()).toBe(1);
    });
    expect(within(factsSection).getByText(/PathGuard/)).toBeTruthy();
    expect(within(factsSection).queryByText(/形态特化/)).toBeNull();
    expect(po.eventCount()).toBe(0);
    expect(screen.getByText("暂无匹配事件")).toBeTruthy();
    expect(querySpy).toHaveBeenCalledWith(agent.id, "沙箱");
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("MEM-03: 置顶记忆即时新增与删除", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<MemoryPage source={new MockDataSource()} agent={agent} />);
    const po = makeMemoryPagePO(user);
    await po.ready();
    expect(po.pinnedItems()).toHaveLength(2);

    await po.addPinned("测试置顶记忆条目");
    await waitFor(() => {
      expect(po.pinnedItems()).toHaveLength(3);
    });
    expect(screen.getByText("测试置顶记忆条目")).toBeTruthy();

    await po.deletePinned("测试置顶记忆条目");
    await waitFor(() => {
      expect(po.pinnedItems()).toHaveLength(2);
    });
    expect(screen.queryByText("测试置顶记忆条目")).toBeNull();
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});
