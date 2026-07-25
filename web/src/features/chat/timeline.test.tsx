import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { deriveTurns, ChatTimelineNav } from "./ChatTimelineNav.jsx";
import type { ChatMessage } from "./chat-state.js";

function makeUserMessage(id: string, content: string, timestamp = ""): ChatMessage {
  return { id, role: "user", content, timestamp, streaming: false };
}

function makeAssistantMessage(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, timestamp: "", streaming: false };
}

describe("deriveTurns", () => {
  it("returns empty array for no messages", () => {
    expect(deriveTurns([])).toEqual([]);
  });

  it("returns empty array when only assistant messages exist", () => {
    const messages = [makeAssistantMessage("a1", "回答")];
    expect(deriveTurns(messages)).toEqual([]);
  });

  it("derives one turn per user message", () => {
    const messages = [
      makeUserMessage("u1", "第一个问题"),
      makeAssistantMessage("a1", "第一个回答"),
      makeUserMessage("u2", "第二个问题"),
      makeAssistantMessage("a2", "第二个回答"),
    ];
    const turns = deriveTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.index).toBe(1);
    expect(turns[0]!.messageId).toBe("u1");
    expect(turns[0]!.anchorId).toBe("turn-u1");
    expect(turns[1]!.index).toBe(2);
    expect(turns[1]!.messageId).toBe("u2");
    expect(turns[1]!.anchorId).toBe("turn-u2");
  });

  it("truncates summary to 20 characters", () => {
    const longContent = "这是一个非常非常长的用户消息内容，超过了二十个字符的限制";
    const messages = [makeUserMessage("u1", longContent)];
    const turns = deriveTurns(messages);
    expect(turns[0]!.summary.length).toBeLessThanOrEqual(21); // 20 + …
    expect(turns[0]!.summary).toContain("…");
  });

  it("keeps short content as-is", () => {
    const messages = [makeUserMessage("u1", "短消息")];
    const turns = deriveTurns(messages);
    expect(turns[0]!.summary).toBe("短消息");
  });

  it("formats relative time", () => {
    const now = new Date();
    const threeMinAgo = new Date(now.getTime() - 3 * 60_000).toISOString();
    const messages = [makeUserMessage("u1", "问题", threeMinAgo)];
    const turns = deriveTurns(messages);
    expect(turns[0]!.relativeTime).toBe("3 分钟前");
  });

  it("returns empty relative time for empty timestamp", () => {
    const messages = [makeUserMessage("u1", "问题", "")];
    const turns = deriveTurns(messages);
    expect(turns[0]!.relativeTime).toBe("");
  });
});

describe("ChatTimelineNav", () => {
  it("renders nothing when no user messages", () => {
    const html = renderToStaticMarkup(
      <ChatTimelineNav messages={[]} activeAnchor={null} onSelectTurn={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("renders nav with correct number of nodes", () => {
    const messages = [
      makeUserMessage("u1", "问题一"),
      makeAssistantMessage("a1", "回答一"),
      makeUserMessage("u2", "问题二"),
    ];
    const html = renderToStaticMarkup(
      <ChatTimelineNav messages={messages} activeAnchor={null} onSelectTurn={() => {}} />,
    );
    expect(html).toContain("chat-timeline-nav");
    expect(html).toContain("timeline-node-u1");
    expect(html).toContain("timeline-node-u2");
  });

  it("marks active node", () => {
    const messages = [
      makeUserMessage("u1", "问题一"),
      makeUserMessage("u2", "问题二"),
    ];
    const html = renderToStaticMarkup(
      <ChatTimelineNav messages={messages} activeAnchor="turn-u2" onSelectTurn={() => {}} />,
    );
    expect(html).toContain('class="chat-timeline-node active"');
  });

  it("has accessible aria-label with turn index and summary", () => {
    const messages = [makeUserMessage("u1", "你好世界")];
    const html = renderToStaticMarkup(
      <ChatTimelineNav messages={messages} activeAnchor={null} onSelectTurn={() => {}} />,
    );
    expect(html).toContain('aria-label="第 1 轮：你好世界"');
  });
});
