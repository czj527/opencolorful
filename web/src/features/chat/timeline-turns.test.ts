import { describe, expect, it } from "vitest";
import { deriveRenderableUserMessages, sameMessage } from "./timeline-turns.js";
import type { ChatMessage, ChatTimelineItem } from "./chat-state.js";

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: "user", content, timestamp: "", streaming: false };
}

describe("sameMessage", () => {
  it("matches by role and content", () => {
    expect(sameMessage({ role: "user", content: "你好" }, { role: "user", content: "你好" })).toBe(true);
    expect(sameMessage({ role: "user", content: "你好" }, { role: "assistant", content: "你好" })).toBe(false);
  });
});

describe("deriveRenderableUserMessages", () => {
  it("returns live user messages when there is no history", () => {
    const messages = [userMessage("user-stream-1", "第一轮"), userMessage("user-stream-2", "第二轮")];
    const timeline: ChatTimelineItem[] = [
      { kind: "message", id: "user-stream-1" },
      { kind: "message", id: "user-stream-2" },
    ];

    const turns = deriveRenderableUserMessages([], messages, timeline);

    expect(turns.map((turn) => turn.id)).toEqual(["user-stream-1", "user-stream-2"]);
  });

  it("uses history anchor ids for turns that render from history entries", () => {
    // 场景：第一轮完成后历史被刷新进 historyEntries，第二轮实时发送。
    // MessageList 中第一轮由 history-0 渲染，时间线锚点必须指向 turn-history-0。
    const historyEntries = [
      { role: "user" as const, content: "第一轮" },
      { role: "assistant" as const, content: "回答一" },
    ];
    const messages = [
      userMessage("user-stream-1", "第一轮"),
      userMessage("user-stream-2", "第二轮"),
    ];
    // PROMPT_SENT 重置后 timeline 只含当前轮
    const timeline: ChatTimelineItem[] = [{ kind: "message", id: "user-stream-2" }];

    const turns = deriveRenderableUserMessages(historyEntries, messages, timeline);

    expect(turns.map((turn) => turn.id)).toEqual(["history-0", "user-stream-2"]);
    expect(turns[0]?.content).toBe("第一轮");
  });

  it("does not duplicate user messages present both in history and timeline", () => {
    const historyEntries = [{ role: "user" as const, content: "同一轮" }];
    const messages = [userMessage("user-stream-1", "同一轮")];
    const timeline: ChatTimelineItem[] = [{ kind: "message", id: "user-stream-1" }];

    const turns = deriveRenderableUserMessages(historyEntries, messages, timeline);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe("user-stream-1");
  });

  it("keeps visible-history index stable when earlier entries are matched", () => {
    const historyEntries = [
      { role: "user" as const, content: "第一轮" },
      { role: "assistant" as const, content: "回答一" },
      { role: "user" as const, content: "第二轮" },
    ];
    const messages = [userMessage("user-stream-2", "第二轮")];
    const timeline: ChatTimelineItem[] = [{ kind: "message", id: "user-stream-2" }];

    // 第二轮与 history[2] 匹配 → visibleHistory = [第一轮, 回答一]
    const turns = deriveRenderableUserMessages(historyEntries, messages, timeline);

    // visibleHistory 中 user 在可见序号 0 → history-0；timeline 第二轮用实时 id
    expect(turns.map((turn) => turn.id)).toEqual(["history-0", "user-stream-2"]);
  });

  it("ignores assistant messages and non-message timeline items", () => {
    const messages: ChatMessage[] = [
      userMessage("user-stream-1", "问"),
      { id: "assistant-1", role: "assistant", content: "答", timestamp: "", streaming: false },
    ];
    const timeline: ChatTimelineItem[] = [
      { kind: "message", id: "user-stream-1" },
      { kind: "message", id: "assistant-1" },
      { kind: "thinking", id: "t1" },
    ];

    const turns = deriveRenderableUserMessages([], messages, timeline);

    expect(turns.map((turn) => turn.id)).toEqual(["user-stream-1"]);
  });
});
