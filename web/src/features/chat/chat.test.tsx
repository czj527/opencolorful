import { describe, expect, it } from "vitest";

import { chatReducer, initialChatState, getStreamCursor, sanitizeMarkdown, isSafeUrl, type ChatAction } from "./chat-state.js";
import type { PlatformEventEnvelope } from "../../lib/types.js";

function makeEvent(type: string, payload: unknown, sequence = 1, streamId = "st1"): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `evt-${streamId}-${sequence}`,
    sessionId: "s1",
    streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

describe("chatReducer", () => {
  it("starts with initial state", () => {
    expect(initialChatState.status).toBe("idle");
    expect(initialChatState.messages).toEqual([]);
    expect(initialChatState.currentStreamId).toBeNull();
  });

  it("PROMPT_SENT sets running state, resets cursor, and adds user message to chat", () => {
    const state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "你好" });
    expect(state.status).toBe("running");
    expect(state.currentStreamId).toBe("st1");
    expect(getStreamCursor(state, "st1")).toBe(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("user");
    expect(state.messages[0]!.content).toBe("你好");
    expect(state.messages[0]!.streaming).toBe(false);
  });

  it("handles message.started", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    // user 消息 + streaming assistant 消息
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]!.streaming).toBe(true);
  });

  it("merges text deltas by sequence", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Hello " }, 2) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "World" }, 3) });
    expect(state.messages[state.messages.length - 1]!.content).toBe("Hello World");
  });

  it("skips duplicate or out-of-order sequences within the same stream", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Hello" }, 5) });
    expect(state.messages[state.messages.length - 1]!.content).toBe("Hello");
    // Duplicate sequence 5 should be skipped
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Duplicate" }, 5) });
    expect(state.messages[state.messages.length - 1]!.content).toBe("Hello");
    // Out-of-order sequence 3 should be skipped
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Old" }, 3) });
    expect(state.messages[state.messages.length - 1]!.content).toBe("Hello");
  });

  it("a new stream restarts from sequence 1 even after a larger old stream", () => {
    // 旧 stream 推进到 sequence 50
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "old-stream", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1, "old-stream") });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "old " }, 50, "old-stream") });
    expect(getStreamCursor(state, "old-stream")).toBe(50);

    // 新 stream 从 sequence 1 开始，不得被旧游标误判为乱序
    state = chatReducer(state, { type: "PROMPT_SENT", streamId: "new-stream", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1, "new-stream") });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "new content" }, 2, "new-stream") });
    expect(state.messages[state.messages.length - 1]!.content).toBe("new content");
    expect(getStreamCursor(state, "new-stream")).toBe(2);
  });

  it("ignores events from non-current streams", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "current", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1, "current") });
    // 旧 stream 的迟到事件不应污染当前视图
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "STALE" }, 99, "old-stream") });
    expect(state.messages[state.messages.length - 1]!.content).toBe("");
  });

  it("handles thinking deltas", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("thinking.delta", { delta: "Let me think..." }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("thinking.delta", { delta: " more thinking" }, 2) });
    expect(state.thinking).toBe("Let me think... more thinking");
  });

  it("handles message.completed", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Partial" }, 2) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "Full response" }, 3) });
    expect(state.messages[state.messages.length - 1]!.content).toBe("Full response");
    expect(state.messages[state.messages.length - 1]!.streaming).toBe(false);
  });

  it("handles tool lifecycle", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.started", { toolCallId: "t1", toolName: "read" }, 1) });
    expect(state.toolCalls.get("t1")!.status).toBe("running");
    expect(state.toolCalls.get("t1")!.toolName).toBe("read");

    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.delta", { toolCallId: "t1", delta: "file content" }, 2) });
    expect(state.toolCalls.get("t1")!.delta).toBe("file content");

    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.completed", { toolCallId: "t1", result: "done", isError: false }, 3) });
    expect(state.toolCalls.get("t1")!.status).toBe("completed");
    expect(state.timeline.map((item) => item.kind)).toEqual(["message", "tool"]);
  });

  it("handles tool error", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.started", { toolCallId: "t1", toolName: "bash" }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.completed", { toolCallId: "t1", result: "permission denied", isError: true }, 2) });
    expect(state.toolCalls.get("t1")!.status).toBe("error");
  });

  it("handles plan updates", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("plan.updated", { items: ["Step 1", "Step 2"] }, 1) });
    expect(state.planItems).toHaveLength(2);
    expect(state.planItems[0]!.text).toBe("Step 1");
  });

  it("handles attachments", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("attachment.available", { attachmentId: "a1", name: "file.txt", mimeType: "text/plain" }, 1) });
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0]!.name).toBe("file.txt");
  });

  it("handles error events", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("error", { code: "PROVIDER_ERROR", message: "API key invalid", retryable: false }, 1) });
    expect(state.status).toBe("error");
    expect(state.error).toBe("API key invalid");
  });

  it("handles turn completion", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("turn.completed", { turnId: "t1" }, 1) });
    expect(state.status).toBe("idle");
  });

  it("handles session status changes", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    expect(state.status).toBe("running");
    state = chatReducer(state, { type: "EVENT", event: makeEvent("session.status", { status: "idle" }, 1) });
    expect(state.status).toBe("idle");
  });

  it("RESET clears all state", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    state = chatReducer(state, { type: "RESET" });
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.currentStreamId).toBeNull();
  });

  it("toggles thinking visibility", () => {
    let state = chatReducer(initialChatState, { type: "TOGGLE_THINKING" });
    expect(state.thinkingCollapsed).toBe(false);
    state = chatReducer(state, { type: "TOGGLE_THINKING" });
    expect(state.thinkingCollapsed).toBe(true);
  });
});

describe("sanitizeMarkdown", () => {
  it("removes javascript: links", () => {
    expect(sanitizeMarkdown("[click](javascript:alert(1))")).toBe("click");
  });

  it("preserves normal links", () => {
    expect(sanitizeMarkdown("[click](https://example.com)")).toBe("[click](https://example.com)");
  });
});

describe("isSafeUrl", () => {
  it("allows https URLs", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
  });

  it("allows http URLs", () => {
    expect(isSafeUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isSafeUrl("not a url")).toBe(false);
  });
});

describe("message resilience", () => {
  it("creates an implicit streaming message when message.delta arrives without prior message.started", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "你好" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "Hello" }, 1) });
    expect(state.messages).toHaveLength(2); // user + newly created assistant
    expect(state.messages[1]!.content).toBe("Hello");
    expect(state.messages[1]!.streaming).toBe(true);
  });

  it("handles message.completed when no streaming message exists", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "test" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "Full response" }, 1) });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]!.content).toBe("Full response");
    expect(state.messages[1]!.streaming).toBe(false);
  });

  it("keeps events that arrive before the prompt HTTP response", () => {
    let state = chatReducer(initialChatState, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1, "early") });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "真实输出" }, 2, "early") });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("tool.started", { toolCallId: "tool-early", toolName: "read" }, 3, "early") });
    state = chatReducer(state, { type: "PROMPT_SENT", streamId: "early", userContent: "用户输入" });

    expect(state.currentStreamId).toBe("early");
    expect(getStreamCursor(state, "early")).toBe(3);
    expect(state.messages.map((message) => message.content)).toEqual(["用户输入", "真实输出"]);
    expect(state.toolCalls.get("tool-early")?.toolName).toBe("read");
  });

  it("accepts early events for a second prompt after clearing the previous stream", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "old", userContent: "第一轮" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "旧回复" }, 1, "old") });
    state = chatReducer(state, { type: "PROMPT_PENDING", userContent: "第二轮" });

    expect(state.currentStreamId).toBeNull();
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.delta", { role: "assistant", delta: "新回复" }, 1, "new") });
    state = chatReducer(state, { type: "PROMPT_SENT", streamId: "new", userContent: "第二轮" });

    expect(state.currentStreamId).toBe("new");
    expect(state.messages.map((message) => message.content)).toEqual(["第一轮", "旧回复", "第二轮", "新回复"]);
    expect(getStreamCursor(state, "new")).toBe(1);
  });
});
