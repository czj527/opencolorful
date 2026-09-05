/**
 * 波次 B3 · L5 单测：分支数据层逻辑（无渲染）。
 * - projectBranchEntries：条目视图 → timeline（锚点/turnId/非 message 条目/回退）
 * - applyEvent：分支事件放行不污染 prompt 流状态（独立 branch-<uuid> 流容错）
 * - MockDataSource 分支场景：tree/entries/switch/regenerate/fork 与 409/404 语义
 *   （wire-shape parity：形状对齐 B2 SessionTreeView/SessionEntriesView）
 */
import { describe, expect, it } from "vitest";

import { applyEvent, createProjector, projectBranchEntries, projectHistory, type BranchEntry } from "../../src/data/projector.js";
import { MockDataSource } from "../../src/data/mock-source.js";
import { BRANCH_DEMO_SESSION_ID } from "../../src/mock-data.js";

const AGENT = "原";

function entry(partial: Partial<BranchEntry> & Pick<BranchEntry, "entryId">): BranchEntry {
  return {
    parentId: null,
    turnId: null,
    type: "message",
    text: "",
    timestamp: "2026-09-05T09:00:00+08:00",
    ...partial,
  };
}

describe("projectBranchEntries", () => {
  it("消息条目携带 entryId/turnId/timestamp 稳定锚点", () => {
    const items = projectBranchEntries([
      entry({ entryId: "e-u1", turnId: "turn-e-u1", role: "user", text: "第一问" }),
      entry({ entryId: "e-a1", parentId: "e-u1", turnId: "turn-e-u1", role: "assistant", text: "第一答" }),
    ], AGENT);
    expect(items).toHaveLength(2);
    const user = items[0];
    const assistant = items[1];
    expect(user).toMatchObject({ type: "message", role: "user", entryId: "e-u1", turnId: "turn-e-u1", body: "第一问" });
    expect(assistant).toMatchObject({ type: "message", role: "assistant", entryId: "e-a1", turnId: "turn-e-u1", body: "第一答" });
  });

  it("非 message 条目（compaction/label）渲染为状态事件行，不产生消息锚点", () => {
    const items = projectBranchEntries([
      entry({ entryId: "e-c1", type: "compaction", text: "压缩摘要" }),
      entry({ entryId: "e-u1", turnId: "turn-e-u1", role: "user", text: "问" }),
    ], AGENT);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "event", kind: "status", title: "上下文压缩" });
    expect(items[1]).toMatchObject({ type: "message", entryId: "e-u1" });
  });

  it("toolResult 角色与 assistant 携带的 toolCalls 均不产生用户锚点", () => {
    const items = projectBranchEntries([
      entry({ entryId: "e-a1", turnId: "turn-e-u1", role: "assistant", text: "答", toolCalls: [{ toolCallId: "t1", toolName: "read", status: "completed" }] }),
    ], AGENT);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "event", kind: "tool", summary: "1 个工具" });
    expect(items[1]).toMatchObject({ type: "message", entryId: "e-a1" });
  });

  it("空条目列表 → 空 timeline（mock 侧回退 projectHistory 不受影响）", () => {
    expect(projectBranchEntries([], AGENT)).toHaveLength(0);
    expect(projectHistory([{ role: "user", content: "旧会话" }], AGENT)).toHaveLength(1);
  });
});

describe("applyEvent 分支事件放行", () => {
  it("session.branch.switched（独立 branch-* 流）不改变 items/streaming/流收养状态", () => {
    const state = createProjector(AGENT);
    state.seenStreams.add("stream-1");
    state.activeStreamId = "stream-1";
    const before = [...state.items];
    applyEvent(state, {
      eventId: "e1", streamId: "branch-abc", sequence: 1, timestamp: new Date().toISOString(),
      type: "session.branch.switched", payload: { branchId: "e-a1b" },
    });
    // 未知流不收养：activeStreamId 保持原值；items 未变
    expect(state.activeStreamId).toBe("stream-1");
    expect(state.pendingPrompt).toBe(false);
    expect(state.items).toEqual(before);
    // 再次到达不同 branch 流也安全（多流并存）
    applyEvent(state, {
      eventId: "e2", streamId: "branch-def", sequence: 1, timestamp: new Date().toISOString(),
      type: "session.branches.changed", payload: { reason: "regenerate" },
    });
    expect(state.activeStreamId).toBe("stream-1");
    expect(state.streaming).toBe(false);
  });

  it("分支事件不破坏既有 compaction 投影（对照组）", () => {
    const state = createProjector(AGENT);
    applyEvent(state, {
      eventId: "e1", streamId: null, sequence: 1, timestamp: new Date().toISOString(),
      type: "session.compacting", payload: {},
    });
    expect(state.items).toHaveLength(1);
    applyEvent(state, {
      eventId: "e2", streamId: "branch-xyz", sequence: 1, timestamp: new Date().toISOString(),
      type: "session.branch.switched", payload: { branchId: "b" },
    });
    expect(state.items).toHaveLength(1);
  });
});

describe("MockDataSource 分支场景（branch-demo）", () => {
  it("初始树：两分支，脚本分支 A 为当前", async () => {
    const source = new MockDataSource();
    const tree = await source.getBranchTree(BRANCH_DEMO_SESSION_ID);
    expect(tree.currentBranchId).toBe("e-a2");
    expect(tree.branches).toHaveLength(2);
    expect(tree.branches.map((branch) => branch.isCurrent)).toEqual([true, false]);
    expect(tree.branches[1]?.leafPreview).toContain("data-theme");
    // 条目视图（当前分支根→叶）
    const entries = await source.getBranchEntries(BRANCH_DEMO_SESSION_ID);
    expect(entries.branchId).toBe("e-a2");
    expect(entries.entries.map((item) => item.entryId)).toEqual(["e-u1", "e-a1", "e-u2", "e-a2"]);
  });

  it("switchBranch：切换后 currentBranchId/entries/timeline 同步为新分支并广播事件", async () => {
    const source = new MockDataSource();
    const updates: string[] = [];
    const unsubscribe = source.subscribeBranchState?.(BRANCH_DEMO_SESSION_ID, (update) => {
      if (update !== null) updates.push(update.kind);
    });
    await source.switchBranch(BRANCH_DEMO_SESSION_ID, "e-a1b");
    const tree = await source.getBranchTree(BRANCH_DEMO_SESSION_ID);
    expect(tree.currentBranchId).toBe("e-a1b");
    expect(tree.branches.find((branch) => branch.branchId === "e-a1b")?.isCurrent).toBe(true);
    const entries = await source.getBranchEntries(BRANCH_DEMO_SESSION_ID);
    expect(entries.entries.map((item) => item.entryId)).toEqual(["e-u1b", "e-a1b"]);
    expect(updates).toContain("switched");
    expect(updates.filter((kind) => kind === "branchesChanged").length).toBeGreaterThanOrEqual(1);
    unsubscribe?.();
  });

  it("switchBranch：未知分支 → 404 NOT_FOUND 语义", async () => {
    const source = new MockDataSource();
    await expect(source.switchBranch(BRANCH_DEMO_SESSION_ID, "no-such-branch")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("regenerateMessage：对用户条目重生成 → 新分支 + 409 busy 语义", async () => {
    const source = new MockDataSource();
    // busy 钩子：置真后下一次操作 409
    source.setBranchBusy(BRANCH_DEMO_SESSION_ID, true);
    await expect(source.regenerateMessage(BRANCH_DEMO_SESSION_ID, "e-u1", "换个问法")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    source.setBranchBusy(BRANCH_DEMO_SESSION_ID, false);

    await source.regenerateMessage(BRANCH_DEMO_SESSION_ID, "e-u1", "换个问法");
    const tree = await source.getBranchTree(BRANCH_DEMO_SESSION_ID);
    // 脚本场景：turn-e-u1 的重生成命中预置兄弟分支 e-a1b
    expect(tree.currentBranchId).toBe("e-a1b");
    expect(tree.branches.length).toBeGreaterThanOrEqual(2);
  });

  it("regenerateMessage：助手条目目标解析到所属轮次用户条目；未知目标 → 404", async () => {
    const source = new MockDataSource();
    // e-a1 是助手条目：服务端语义沿父链解析到该轮用户条目（e-u1）→ 重生成成功
    await source.regenerateMessage(BRANCH_DEMO_SESSION_ID, "e-a1", "换个问法");
    const tree = await source.getBranchTree(BRANCH_DEMO_SESSION_ID);
    expect(tree.currentBranchId).toBe("e-a1b");
    // 脚本 turn 流仍在计时：abort 收敛到空闲后再验证 404（busy 语义由 BRANCH-05 覆盖）
    await source.abort(BRANCH_DEMO_SESSION_ID);
    await expect(source.regenerateMessage(BRANCH_DEMO_SESSION_ID, "missing", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("forkSession：当前分支 → 新独立会话 + 源会话 branches.changed{fork}", async () => {
    const source = new MockDataSource();
    const updates: string[] = [];
    const unsubscribe = source.subscribeBranchState?.(BRANCH_DEMO_SESSION_ID, (update) => {
      if (update?.kind === "branchesChanged") updates.push(update.reason);
    });
    const newSessionId = await source.forkSession(BRANCH_DEMO_SESSION_ID);
    expect(newSessionId).not.toBe(BRANCH_DEMO_SESSION_ID);
    // 新会话可交互：树与条目齐备（fork 内容 = 当前分支条目）
    const forkEntries = await source.getBranchEntries(newSessionId);
    expect(forkEntries.entries.map((item) => item.entryId)).toEqual(["e-u1", "e-a1", "e-u2", "e-a2"]);
    const forkTree = await source.getBranchTree(newSessionId);
    expect(forkTree.branches.length).toBeGreaterThanOrEqual(1);
    expect(updates).toContain("fork");
    unsubscribe?.();
  });

  it("非分支会话（desktop）：tree 返回空 branches（空会话语义）", async () => {
    const source = new MockDataSource();
    const tree = await source.getBranchTree("desktop");
    expect(tree).toEqual({ currentBranchId: null, branches: [] });
  });
});
