/**
 * L5 · P1 审计修复（§10-5）· 分支树刷新并发代次守卫（视图面）。
 *
 * BranchSwitcher 的 refreshTree 由 branches.changed 事件、弹层打开、手动刷新并发
 * 触发——旧响应落地不得覆盖新响应（树显示已被切走的分支列表）。
 * 修复后：每次发出前递增组件级代次，响应落地校验，过期响应不 setState。
 *
 * 覆盖：
 * - TREE-RACE-01 同实例两次并发树 GET：新响应先落、旧响应后落 → 最终显示新树；
 * - TREE-RACE-02 单次加载（无并发）语义不变：loading → 树呈现（计数 label）；
 * - TREE-RACE-03 换 sessionId：旧会话在途响应落地后不 setState（不串会话）。
 * 判别力：禁用代次校验后 01/03 失败（旧响应覆盖/串会话）。
 *
 * 断言形态：leafPreview/isCurrent 渲染在展开的菜单里，trigger 只显示计数——
 * 树内容断言先点击 trigger 展开，再 within(menu) 检查。
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { BranchSwitcher } from "./components/BranchSwitcher.js";
import type { BranchTreeView, DesktopDataSource } from "./data/source.js";

function treeOf(current: string | null, labels: string[]): BranchTreeView {
  return {
    currentBranchId: current,
    branches: labels.map((label, index) => ({
      branchId: `leaf-${index}`,
      leafEntryId: `leaf-${index}`,
      leafPreview: label,
      entryCount: 1,
      updatedAt: "2026-09-07T00:00:00.000Z",
      isCurrent: label === current,
    })),
  };
}

interface DeferredTree {
  promise: Promise<BranchTreeView>;
  resolve(tree: BranchTreeView): void;
}

function deferredTree(): DeferredTree {
  let resolve!: (tree: BranchTreeView) => void;
  const promise = new Promise<BranchTreeView>((r) => { resolve = r; });
  return { promise, resolve };
}

type BranchUpdate = { kind: string };

/** 最小数据源桩：仅实现 BranchSwitcher 用到的三个方法（getBranchTree 可控；subscribeBranchState 可捕获 handler） */
function makeSource(
  getTree: (sessionId: string) => Promise<BranchTreeView>,
  subscribe?: (sessionId: string, handler: (update: BranchUpdate) => void) => () => void,
): DesktopDataSource {
  const base = {
    getBranchTree: getTree,
    subscribeBranchState: subscribe ?? (() => () => {}),
    switchBranch: () => Promise.resolve(),
  };
  return base as unknown as DesktopDataSource;
}

afterEach(() => {
  cleanup();
});

describe("分支树刷新并发代次守卫（P1 审计修复回归）", () => {
  it("TREE-RACE-01: 同实例新响应先落、旧响应后落 → 最终显示新树，旧代次响应被丢弃", async () => {
    const user = userEvent.setup();
    const newTree = treeOf("新分支（当前）", ["旧分支", "新分支（当前）"]);
    const oldTree = treeOf("旧分支（当前）", ["旧分支（当前）", "新分支"]);
    const first = deferredTree(); // 挂载刷新（将被事件刷新取代）
    const second = deferredTree(); // branches.changed 事件刷新（新代次）
    const responses = [first.promise, second.promise];
    // ref 包装：TS 控制流不窄化对象属性（闭包内赋值后仍可调用）
    const handlerRef: { current: ((update: BranchUpdate) => void) | null } = { current: null };
    const source = makeSource(() => {
      const next = responses.shift();
      if (next === undefined) throw new Error("超出预期次数的树请求");
      return next;
    }, (_sessionId, handler) => {
      handlerRef.current = handler;
      return () => { handlerRef.current = null; };
    });

    render(<BranchSwitcher source={source} sessionId="sess-1" running={false} onForked={() => {}} />);
    // 同实例第二次刷新：branches.changed 事件（新代次，取代挂载刷新）
    if (handlerRef.current === null) throw new Error("subscribeBranchState 未被调用");
    handlerRef.current({ kind: "branchesChanged" });

    second.resolve(newTree);
    await waitFor(() => expect(screen.getByText("分支 2")).toBeTruthy());
    // 旧代次响应（挂载刷新）后落：不得覆盖
    first.resolve(oldTree);

    // 展开菜单核对树内容：当前项 = 新分支（当前），旧代次的"旧分支（当前）"不存在
    await user.click(screen.getByTestId("oc-branch-switcher"));
    const menu = screen.getByTestId("oc-branch-menu");
    await waitFor(() => expect(within(menu).getByText("新分支（当前）")).toBeTruthy());
    expect(within(menu).getByText("新分支（当前）").closest("button")?.className).toContain("is-current");
    expect(within(menu).queryByText("旧分支（当前）")).toBeNull();
  });

  it("TREE-RACE-02: 无并发时加载语义不变——loading → 树呈现（计数 label）", async () => {
    const tree = treeOf("主分支", ["主分支"]);
    let resolveTree!: (tree: BranchTreeView) => void;
    const source = makeSource(() => new Promise<BranchTreeView>((r) => { resolveTree = r; }));

    render(<BranchSwitcher source={source} sessionId="sess-1" running={false} onForked={() => {}} />);
    expect(screen.getByText("分支…")).toBeTruthy(); // loading 态
    resolveTree(tree);
    await waitFor(() => expect(screen.getByText("分支 1")).toBeTruthy());
  });

  it("TREE-RACE-03: 换 sessionId 后旧会话在途响应落地 → 不 setState 不串会话", async () => {
    const user = userEvent.setup();
    const stale = deferredTree(); // 旧会话的树（由测试延迟落定）
    const fresh = deferredTree();
    const bySession = new Map<string, Promise<BranchTreeView>>([["sess-old", stale.promise], ["sess-new", fresh.promise]]);
    const source = makeSource((sessionId) => {
      const promise = bySession.get(sessionId);
      if (promise === undefined) throw new Error(`未预期的会话 ${sessionId}`);
      return promise;
    });

    const { rerender } = render(
      <BranchSwitcher source={source} sessionId="sess-old" running={false} onForked={() => {}} />,
    );
    rerender(<BranchSwitcher source={source} sessionId="sess-new" running={false} onForked={() => {}} />);

    fresh.resolve(treeOf("新会话分支", ["新会话分支"]));
    await waitFor(() => expect(screen.getByText("分支 1")).toBeTruthy());
    // 旧会话响应落地：换会话已递增代次，不得覆盖新会话树
    stale.resolve(treeOf("旧会话分支", ["旧会话分支"]));

    await user.click(screen.getByTestId("oc-branch-switcher"));
    const menu = screen.getByTestId("oc-branch-menu");
    await waitFor(() => expect(within(menu).getByText("新会话分支")).toBeTruthy());
    expect(within(menu).queryByText("旧会话分支")).toBeNull();
  });
});
