/**
 * L5 · MEM-01/02/03 + MAGENT-01（记忆页加载/搜索/置顶/后台整理）Mock 渲染层回归。
 * MEM-01/03 用生产 MockDataSource；MEM-02 双覆盖：生产 Mock（A4d 已修复 getMemoryData
 * 忽略 query 的 parity 缺口，对齐服务端 q 行为）+ fixture 注入表（A2 既有 UI 契约回归）；
 * MAGENT-01 经 overrideSource 注入 ipc 形状与维护脚本（MemoryPage 仅 ipc 模式订阅维护状态）。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { MemoryPage } from "./pages/MemoryPage.js";
import { MockDataSource } from "./data/mock-source.js";
import { agents, type MemoryMaintenance } from "./mock-data.js";
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
  // A2 既有 UI 契约回归：注入表模拟服务端 q 行为。生产 Mock 的同链路用例见下方
  // （A4d 已修复 getMemoryData 忽略 query 的 parity 缺口，注入用例保留作防回归对照）。
  const basePage: MemoryPageData = await base.getMemoryData(agent.id);
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

it("MEM-02: 生产 Mock getMemoryData 按 q 过滤（A4d parity 修复）——输入关键字 → 防抖后列表只剩匹配项", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<MemoryPage source={new MockDataSource()} agent={agent} />);
    const po = makeMemoryPagePO(user);
    await po.ready();
    expect(po.factCount()).toBe(3);
    expect(po.eventCount()).toBe(3);

    await po.search("沙箱");

    // 防抖 + 生产 Mock 过滤后：仅命中的事实保留（限定在事实 section 内断言，
    // 编译制品「长期」块文本与事实内容有交集，不能全屏匹配）
    const factsSection = po.section(/^已审批事实/);
    await waitFor(() => {
      expect(po.factCount()).toBe(1);
    });
    expect(within(factsSection).getByText(/PathGuard/)).toBeTruthy();
    expect(within(factsSection).queryByText(/形态特化/)).toBeNull();
    expect(po.eventCount()).toBe(0);
    expect(screen.getByText("暂无匹配事件")).toBeTruthy();

    // ASCII 大小写折叠对齐服务端 FTS unicode61：小写 pathguard 仍命中同一条事实
    const searchInput = screen.getByPlaceholderText("搜索事实与事件…");
    await user.clear(searchInput);
    await user.type(searchInput, "pathguard");
    await waitFor(() => {
      expect(po.factCount()).toBe(1);
    });
    expect(within(po.section(/^已审批事实/)).getByText(/PathGuard/)).toBeTruthy();

    // 清空关键字 → 恢复全量
    await user.clear(searchInput);
    await waitFor(() => {
      expect(po.factCount()).toBe(3);
      expect(po.eventCount()).toBe(3);
    });
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});

it("MAGENT-01: 立即整理 → 维护状态 running→completed 实时切换 → 查看报告出现 → 报告文本渲染", async () => {
  const tracker = trackConsoleErrors();
  const user = userEvent.setup();
  const runId = "run_mock-a4d-magent";
  const reportText = [
    "# 记忆整理运行报告",
    "状态：completed",
    "批次：无",
    "迭代：0，预算估算：0 tokens",
    "",
    "## 提案",
    "",
    "## 未解决问题",
  ].join("\n");
  const base = new MockDataSource();
  // MemoryPage 仅在 source.info.mode === "ipc" 时订阅维护状态：注入 ipc 形状 +
  // 脚本化 memory.agent.* 序列（started → processing(策略审批) → completed），
  // 对齐 resolver.ts 真实 SSE 推进（A4d lane 本地脚本，不新增全局 fixture 状态）。
  const maintenanceHandlers = new Set<(maintenance: MemoryMaintenance) => void>();
  let deepDiveAgentId = "";
  let reportRequest: { agentId: string; runId: string } | null = null;
  const pushMaintenance = (maintenance: MemoryMaintenance) => {
    for (const handler of maintenanceHandlers) handler(maintenance);
  };
  const source = overrideSource(base, {
    info: { mode: "ipc", connected: true, label: "测试 · ipc 形状注入" },
    getMemoryData: () => base.getMemoryData(agent.id).then((page) => ({ ...page, maintenance: null })),
    subscribeMemoryMaintenance: (_agentId: string, handler: (maintenance: MemoryMaintenance) => void) => {
      maintenanceHandlers.add(handler);
      return () => {
        maintenanceHandlers.delete(handler);
      };
    },
    deepDiveMemory: (requestedAgentId: string) => {
      deepDiveAgentId = requestedAgentId;
      window.setTimeout(() => pushMaintenance({ status: "started", runId, at: new Date().toISOString() }), 120);
      window.setTimeout(() => pushMaintenance({ status: "processing", phase: "策略审批", runId, at: new Date().toISOString() }), 260);
      window.setTimeout(() => pushMaintenance({ status: "completed", phase: "整理完成", runId, at: new Date().toISOString() }), 420);
      return Promise.resolve();
    },
    getMemoryRunReport: (requestedAgentId: string, requestedRunId: string) => {
      reportRequest = { agentId: requestedAgentId, runId: requestedRunId };
      return Promise.resolve(reportText);
    },
  });
  try {
    render(<MemoryPage source={source} agent={agent} />);
    const po = makeMemoryPagePO(user);
    await po.ready();

    // 后台整理 stat 卡锚点：初始空闲（getMemoryData.maintenance = null）
    const maintenanceValue = () => {
      const card = screen.getByText("后台整理").closest(".stat-card");
      if (card === null) throw new Error("未找到后台整理 stat 卡");
      return within(card as HTMLElement);
    };
    await waitFor(() => {
      expect(maintenanceValue().getByText("空闲")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "立即整理" }));
    expect(deepDiveAgentId).toBe(agent.id);

    // UI 先本地置 queued（runDeepDive 的 .then），随后脚本按真实时序推进
    await waitFor(() => {
      expect(maintenanceValue().getByText("已排队")).toBeTruthy();
    });
    await waitFor(() => {
      expect(maintenanceValue().getByText("正在整理往事")).toBeTruthy();
    });
    await waitFor(() => {
      expect(maintenanceValue().getByText("正在合并相近记忆")).toBeTruthy();
    });
    await waitFor(() => {
      expect(maintenanceValue().getByText("整理完成")).toBeTruthy();
    });
    // runId 进入副标签（run <前 12 位>… · 时间）
    expect(maintenanceValue().getByText(/run run_mock-a4d…/)).toBeTruthy();

    // 「查看报告」仅在 status ∈ completed|deferred|failed 且 runId 存在时出现；
    // 点击后报告请求参数正确、报告文本完整渲染
    await user.click(screen.getByRole("button", { name: "查看报告" }));
    expect(reportRequest).toEqual({ agentId: agent.id, runId });
    const summary = await screen.findByText("最近运行报告（脱敏）");
    const pre = summary.closest("details")?.querySelector("pre");
    expect(pre?.textContent).toBe(reportText);
  } finally {
    tracker.restore();
  }
  tracker.expectNoErrors();
});
