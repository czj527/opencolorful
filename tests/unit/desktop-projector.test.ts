import { describe, expect, it } from "vitest";

import type { ChatEvent, ChatMessage, TimelineItem } from "../../desktop/src/mock-data.js";
import {
  applyEvent,
  applyLocalUserMessage,
  createProjector,
  markPromptFailed,
  markPromptSent,
  projectHistory,
  seedItems,
  snapshotOf,
  type HistoryEntry,
  type LiveEnvelope,
  type ProjectorState,
} from "../../desktop/src/data/projector.js";

/** 构造最小 Envelope；默认挂在已收养的 stream（s1）上 */
function env(type: string, payload: unknown, streamId: string | null = "s1", eventId = `${type}-${counter++}`): LiveEnvelope {
  return { eventId, streamId, sequence: counter, timestamp: "2026-08-27T00:00:00.000Z", type, payload };
}

let counter = 0;

function asMessage(item: TimelineItem): ChatMessage {
  expect(item.type).toBe("message");
  return item as ChatMessage;
}

/** 最后一条 item（假定存在） */
function lastItem(p: ProjectorState): TimelineItem {
  const item = p.items[p.items.length - 1];
  if (item === undefined) throw new Error("items 为空");
  return item;
}

function asEvent(item: TimelineItem): ChatEvent | undefined {
  return item.type === "event" ? item : undefined;
}

describe("projector O(1)：合批窗口内就地累积，快照（flush）时才重建数组", () => {
  it("一帧内多次 applyEvent 不重建 items（引用稳定），snapshotOf 才产生新数组引用", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyEvent(p, env("turn.started", {}));
    applyEvent(p, env("message.started", {}));
    const base = p.items;

    // 同一合批窗内的 3 个 delta：全部就地累积，数组未被重建
    applyEvent(p, env("message.delta", { delta: "a" }));
    applyEvent(p, env("message.delta", { delta: "b" }));
    applyEvent(p, env("message.delta", { delta: "c" }));
    expect(p.items).toBe(base);

    // flush：重建一次数组，快照内容为累积结果
    const snap = snapshotOf(p);
    expect(snap.items).not.toBe(base);
    expect(snap.items).toHaveLength(1);
    expect(asMessage(snap.items[0]!).body).toBe("abc");

    // 下一帧继续：再次 flush 又产生新引用（不可变契约），内容继续累积
    applyEvent(p, env("message.delta", { delta: "d" }));
    const snap2 = snapshotOf(p);
    expect(snap2.items).not.toBe(snap.items);
    expect(asMessage(snap2.items[0]!).body).toBe("abcd");
  });

  it("纯 streaming 标志变化不重建数组（dirty=false 时快照复用同一引用）", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyEvent(p, env("session.status", { status: "running" }));
    const items = p.items;
    expect(snapshotOf(p).items).toBe(items);
    expect(snapshotOf(p).streaming).toBe(true);
    applyEvent(p, env("session.status", { status: "idle" }));
    expect(snapshotOf(p).streaming).toBe(false);
  });

  it("事件顺序与快照形状不变：多轮混合事件按到达顺序落位", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyLocalUserMessage(p, "请重构");
    applyEvent(p, env("plan.updated", { items: ["读代码", "改代码"] }));
    applyEvent(p, env("message.started", {}));
    applyEvent(p, env("message.delta", { delta: "好的" }));
    applyEvent(p, env("memory.recall.started", { recallId: "r1" }));
    applyEvent(p, env("memory.recall.completed", { recallId: "r1", resultCount: 2, layer: "摘要层" }));
    applyEvent(p, env("message.delta", { delta: "，开始。" }));
    applyEvent(p, env("message.completed", { content: "好的，开始。" }));

    const snap = snapshotOf(p);
    const kinds = snap.items.map((item) => item.type === "message" ? `msg:${item.role}` : `evt:${item.kind}`);
    expect(kinds).toEqual(["msg:user", "evt:plan", "msg:assistant", "evt:memory"]);
    const assistant = snap.items.filter((item) => item.type === "message" && item.role === "assistant");
    expect(assistant.map((m) => asMessage(m).body)).toEqual(["好的，开始。"]);
    // 事件按"同 id 就位"upsert：plan 与 recall 只出现一次并在原位置更新
    const plan = snap.items.find((item): item is ChatEvent => item.type === "event" && item.kind === "plan");
    expect(plan?.summary).toBe("2 项");
    const recall = snap.items.find((item): item is ChatEvent => item.type === "event" && item.kind === "memory");
    expect(recall?.summary).toBe("命中 2 条相关记忆");
  });
});

describe("projector O(1)：delta 流中 thinking / tool 事件不受影响", () => {
  it("thinking、tool 事件穿插在 delta 连发之间：事件就位更新，消息指针持续指向助手消息", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyEvent(p, env("turn.started", {}));
    applyEvent(p, env("thinking.delta", { delta: "先看上下文" }));
    applyEvent(p, env("message.started", {}));
    applyEvent(p, env("thinking.delta", { delta: "，再动手" }));
    applyEvent(p, env("message.delta", { delta: "收到" }));
    applyEvent(p, env("tool.started", { toolCallId: "t1", toolName: "read" }));
    applyEvent(p, env("tool.delta", { toolCallId: "t1", delta: "src/" }));
    applyEvent(p, env("message.delta", { delta: "，正在读取" }));
    applyEvent(p, env("tool.completed", { toolCallId: "t1", result: "/a.ts" }));
    applyEvent(p, env("message.delta", { delta: "完成。" }));

    const snap = snapshotOf(p);
    // 顺序：thinking → assistant → tool（thinking 在 assistant 前创建，随后被 upsert 更新）
    expect(snap.items.map((item) => item.type === "message" ? "msg" : `evt:${item.kind}`)).toEqual([
      "evt:thinking", "msg", "evt:tool",
    ]);
    const thinking = snap.items[0]!;
    expect(thinking.type === "event" && thinking.detail).toBe("先看上下文，再动手");
    const tool = snap.items[2]!;
    expect(tool.type === "event" && tool.tools?.length).toBe(1);
    expect(tool.type === "event" && tool.tools?.[0]?.status).toBe("succeeded");
    expect(asMessage(snap.items[1]!).body).toBe("收到，正在读取完成。");
    // 事务结束：助手消息关闭 streaming，thinking 收尾
    applyEvent(p, env("turn.completed", { usage: { totalTokens: 42 } }));
    const done = snapshotOf(p);
    const msg = asMessage(done.items[1]!);
    expect(msg.streaming).toBe(false);
    expect(msg.meta).toBe("42 tokens");
    const doneThinking = done.items[0]!;
    expect(doneThinking.type === "event" && doneThinking.summary).toBe("思考完成");
  });

  it("thinking / tool 同 id 事件反复到达只更新不重复追加（索引定位正确）", () => {
    const p = createProjector("原");
    markPromptSent(p, "s2");
    for (let index = 0; index < 4; index += 1) {
      applyEvent(p, env("thinking.delta", { delta: `段${index}` }, "s2"));
    }
    for (let index = 0; index < 3; index += 1) {
      applyEvent(p, env("tool.started", { toolCallId: `t${index}`, toolName: `grep` }, "s2"));
    }
    const snap = snapshotOf(p);
    expect(snap.items.filter((item) => item.type === "event" && item.kind === "thinking")).toHaveLength(1);
    expect(snap.items.filter((item) => item.type === "event" && item.kind === "tool")).toHaveLength(1);
    const thinking = snap.items[0]!;
    expect(thinking.type === "event" && thinking.detail).toBe("段0段1段2段3");
    const tool = snap.items[1]!;
    expect(tool.type === "event" && tool.tools?.length).toBe(3);
  });
});

describe("projector O(1)：乱序 id 场景下索引正确", () => {
  it("事件在消息前后交错创建/更新，upsert 均命中正确槽位", () => {
    const p = createProjector("原");
    markPromptSent(p, "s3");
    // tool 事件先于 message 创建（索引在前）
    applyEvent(p, env("tool.started", { toolCallId: "x1", toolName: "ls" }, "s3"));
    applyEvent(p, env("message.started", {}, "s3"));
    applyEvent(p, env("message.delta", { delta: "hi" }, "s3"));
    // message 之后又更新 tool（同 id 更新，索引应命中第 0 槽）
    applyEvent(p, env("tool.completed", { toolCallId: "x1", result: "desktop/", isError: false }, "s3"));
    const snap = snapshotOf(p);
    expect(snap.items).toHaveLength(2);
    expect(asMessage(snap.items[1]!).body).toBe("hi");
    const tool = snap.items[0]!;
    expect(tool.type === "event" && tool.tools?.[0]?.target).toBe("desktop/");

    // 第二轮消息：delta 落在新的 assistant 消息上（指针推进），不受前面事件影响
    applyEvent(p, env("message.completed", { content: "hi" }, "s3"));
    applyEvent(p, env("message.delta", { delta: "再来" }, "s3"));
    expect(snapshotOf(p).items).toHaveLength(3);
    expect(asMessage(lastItem(p)).body).toBe("再来");
  });

  it("空 delta 被忽略，不产生任何快照变化", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyEvent(p, env("message.started", {}));
    applyEvent(p, env("message.delta", { delta: "" }));
    expect(p.dirty).toBe(true); // message.started 已置脏
    const before = p.items;
    expect(snapshotOf(p).items).not.toBe(before);
  });
});

describe("projector：历史投影（seedItems）后索引重建，实时事件定位正确", () => {
  const history: readonly HistoryEntry[] = [
    { role: "user", content: "历史问题" },
    { role: "assistant", content: "历史回答", thinking: "历史思考", toolCalls: [{ toolCallId: "h1", toolName: "grep", status: "completed", result: "ok" }] },
  ];

  it("seedItems 重建索引与末消息指针；delta/upsert 落到正确位置", () => {
    const p = createProjector("原");
    seedItems(p, projectHistory(history, "原"));
    const loaded = snapshotOf(p);
    expect(loaded.items.map((item) => item.type === "message" ? "msg" : `evt:${item.kind}`)).toEqual([
      "msg", "evt:thinking", "evt:tool", "msg",
    ]);
    const last = asMessage(loaded.items[3]!);
    expect(last.body).toBe("历史回答");

    markPromptSent(p, "h1");
    // 历史里最后一条 assistant 已完成（非 streaming）→ delta 追加新消息，而非改写历史
    applyEvent(p, env("message.delta", { delta: "新回复" }, "h1"));
    const snap = snapshotOf(p);
    expect(snap.items).toHaveLength(5);
    expect(asMessage(snap.items[4]!).body).toBe("新回复");
    // 紧接着的 delta 落在新消息上
    applyEvent(p, env("message.delta", { delta: "继续" }, "h1"));
    const snap2 = snapshotOf(p);
    expect(asMessage(snap2.items[4]!).body).toBe("新回复继续");
    // 历史事件不被实时事件干扰：thinking/tool 仍是历史条目
    expect(snap2.items[1]!.type === "event" && snap2.items[1]!.kind).toBe("thinking");
    expect(snap2.items[2]!.type === "event" && snap2.items[2]!.kind).toBe("tool");
  });

  it("外部直接覆写 items（mock 源遗留写法）后索引自愈，表现与旧的线性扫描一致", () => {
    const p = createProjector("原");
    const seeded = projectHistory(history, "原");
    p.items = [...seeded]; // 模拟 mock-source 直接赋值（绕过 seedItems）
    markPromptSent(p, "h1");
    // 覆盖后末消息指针已失效：旧行为会反向扫到最后一条 message（历史 assistant，"完成"态）
    applyEvent(p, env("message.delta", { delta: "续" }, "h1"));
    let snap = snapshotOf(p);
    expect(snap.items).toHaveLength(5); // 追加而非改写
    expect(asMessage(snap.items[4]!).body).toBe("续");
    // 自愈后指针已回填：下一个 delta 更新新消息
    applyEvent(p, env("message.delta", { delta: "写" }, "h1"));
    snap = snapshotOf(p);
    expect(asMessage(snap.items[4]!).body).toBe("续写");
  });
});

describe("projector：streaming 标志转换与错误路径", () => {
  it("session.status / turn.started / turn.completed / error 驱动 streaming 转换", () => {
    const p = createProjector("原");
    markPromptSent(p, "s1");
    applyEvent(p, env("session.status", { status: "running" }));
    expect(snapshotOf(p).streaming).toBe(true);
    applyEvent(p, env("turn.completed", { usage: {} }));
    expect(snapshotOf(p).streaming).toBe(false);
    applyEvent(p, env("turn.started", {}));
    expect(snapshotOf(p).streaming).toBe(true);
    applyEvent(p, env("error", { message: "爆了" }));
    const snap = snapshotOf(p);
    expect(snap.streaming).toBe(false);
    const last = lastItem(p);
    expect(asEvent(last)?.summary).toBe("爆了");
  });

  it("prompt 失败路径：乐观用户消息存在 + 错误状态事件 + streaming 关闭", () => {
    const p = createProjector("原");
    applyLocalUserMessage(p, "你好");
    expect(snapshotOf(p).streaming).toBe(true);
    markPromptFailed(p, "网络错误");
    const snap = snapshotOf(p);
    expect(snap.streaming).toBe(false);
    expect(p.pendingPrompt).toBe(false);
    const last = lastItem(p);
    expect(last.type === "event" && last.kind).toBe("status");
    expect(last.type === "event" && last.summary).toBe("网络错误");
    // 用户消息仍在位
    expect(asMessage(p.items[0]!).body).toBe("你好");
  });
});