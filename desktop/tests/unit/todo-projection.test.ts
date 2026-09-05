/**
 * 波次 B5b · L5 单测（无渲染）：durable session todo 只读投影。
 * - applyTodoSnapshot：SessionView.todos 种子（打开/重启恢复）
 * - todo.updated 事件：整表替换、空列表清空、todo:<sessionId> 流不被 prompt 流收养
 * 渲染层在 src/todo-card.mock.test.tsx。
 */
import { describe, expect, it } from "vitest";

import { applyEvent, applyTodoSnapshot, createProjector, snapshotOf, type LiveEnvelope } from "../../src/data/projector.js";
import type { SessionTodoItem } from "../../src/mock-data.js";

const INITIAL: readonly SessionTodoItem[] = [
  { content: "梳理语义令牌分层", status: "completed", priority: "high" },
  { content: "落地 data-theme 覆盖方案", status: "in_progress", priority: "high", activeForm: "正在落地 data-theme 覆盖方案" },
];

function envelope(items: unknown, sequence = 1): LiveEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-todo-${sequence}`,
    sessionId: "s1",
    streamId: `todo:s1`,
    sequence,
    timestamp: "2026-09-05T10:00:00+08:00",
    type: "todo.updated",
    payload: { items },
  } as LiveEnvelope;
}

describe("todo 只读投影", () => {
  it("applyTodoSnapshot：SessionView.todos 种子进入快照（打开/重启恢复）", () => {
    const state = createProjector("原");
    applyTodoSnapshot(state, INITIAL);
    expect(snapshotOf(state).todos).toEqual(INITIAL);
  });

  it("todo.updated：整表替换（最后写入胜出）", () => {
    const state = createProjector("原");
    applyTodoSnapshot(state, INITIAL);
    const replaced: readonly SessionTodoItem[] = [
      { content: "梳理语义令牌分层", status: "completed", priority: "high" },
      { content: "落地 data-theme 覆盖方案", status: "completed", priority: "high" },
    ];
    applyEvent(state, envelope(replaced, 1));
    expect(snapshotOf(state).todos).toEqual(replaced);
  });

  it("todo.updated：空列表 = 显式清空（卡片消失语义）", () => {
    const state = createProjector("原");
    applyTodoSnapshot(state, INITIAL);
    applyEvent(state, envelope([], 1));
    expect(snapshotOf(state).todos).toEqual([]);
  });

  it("todo.updated 条目防御式解析：非法 status/priority 回退 pending/medium，保留 activeForm", () => {
    const state = createProjector("原");
    applyEvent(state, envelope([
      { content: "任务A", status: "nonsense", priority: "urgent", activeForm: "正在做任务A" },
      { content: "任务B", status: "completed", priority: "low" },
    ], 1));
    expect(snapshotOf(state).todos).toEqual([
      { content: "任务A", status: "pending", priority: "medium", activeForm: "正在做任务A" },
      { content: "任务B", status: "completed", priority: "low" },
    ]);
  });

  it("非对象/缺 items 的 payload 不抛错（回退空列表）", () => {
    const state = createProjector("原");
    applyTodoSnapshot(state, INITIAL);
    applyEvent(state, {
      protocolVersion: 1, eventId: "ev-bad", sessionId: "s1", streamId: "todo:s1", sequence: 9,
      timestamp: "2026-09-05T10:00:00+08:00", type: "todo.updated", payload: null,
    } as unknown as LiveEnvelope);
    expect(snapshotOf(state).todos).toEqual([]);
  });

  it("todo:<sessionId> 流不被 prompt 流收养（投影仅替换 todos，不产生 items）", () => {
    const state = createProjector("原");
    const itemsBefore = state.items.length;
    applyEvent(state, envelope(INITIAL, 1));
    expect(state.items.length).toBe(itemsBefore);
    expect(state.activeStreamId).toBeNull();
    expect(state.seenStreams.size).toBe(0);
  });
});
