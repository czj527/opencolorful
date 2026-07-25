import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { chatReducer, initialChatState, type ChatTimelineItem } from "./chat-state.js";
import { ContextUsageRing } from "./ContextUsageRing.jsx";
import { MessageComposer } from "./MessageComposer.jsx";
import { MessageList } from "./MessageList.js";
import type { ContextUsage, ModelSummary, PlatformEventEnvelope, TokenUsage } from "../../lib/types.js";

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

const USAGE_A: TokenUsage = { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180 };
const USAGE_B: TokenUsage = { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280 };
const CONTEXT: ContextUsage = { tokens: 12000, contextWindow: 32768, percent: 36.6 };

describe("chatReducer usage/context", () => {
  it("turn.completed accumulates totals, updates context and records per-turn usage", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.started", { role: "assistant" }, 1) });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("message.completed", { role: "assistant", content: "答" }, 2),
    });
    const assistantId = state.messages[state.messages.length - 1]!.id;
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("turn.completed", { turnId: "t1", usage: USAGE_A, context: CONTEXT }, 3),
    });

    expect(state.status).toBe("idle");
    expect(state.usageTotals).toEqual(USAGE_A);
    expect(state.contextUsage).toEqual(CONTEXT);
    expect(state.usageTurns).toBe(1);
    expect(state.turnUsages.get(assistantId)).toEqual(USAGE_A);
    // 命中率 = cacheRead / (input + cacheRead) = 20 / 120
    expect(state.cacheHitRate).toBeCloseTo(20 / 120, 5);
  });

  it("accumulates across turns and recomputes cache hit rate", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "一" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "答一" }, 1) });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("turn.completed", { turnId: "t1", usage: USAGE_A }, 2) });
    state = chatReducer(state, { type: "PROMPT_SENT", streamId: "st2", userContent: "二" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "答二" }, 1, "st2") });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("turn.completed", { turnId: "t2", usage: USAGE_B }, 2, "st2") });

    expect(state.usageTotals).toEqual({
      input: 300,
      output: 130,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 460,
    });
    expect(state.usageTurns).toBe(2);
    // 20 / (300 + 20)
    expect(state.cacheHitRate).toBeCloseTo(20 / 320, 5);
  });

  it("turn.completed without usage/context keeps previous usage state", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("turn.completed", { turnId: "t1" }, 1) });
    expect(state.usageTotals.totalTokens).toBe(0);
    expect(state.usageTurns).toBe(0);
    expect(state.contextUsage).toBeNull();
    expect(state.cacheHitRate).toBeNull();
  });

  it("cache hit rate is null when denominator is zero", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, { type: "EVENT", event: makeEvent("message.completed", { role: "assistant", content: "答" }, 1) });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("turn.completed", { turnId: "t1", usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }, 2),
    });
    expect(state.cacheHitRate).toBeNull();
  });

  it("safely ignores session.compacting and session.compacted", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    const before = state;
    state = chatReducer(state, { type: "EVENT", event: makeEvent("session.compacting", { reason: "manual" }, 1) });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacted", { reason: "manual", tokensBefore: 1000, tokensAfter: 200, summary: "摘要" }, 2),
    });
    expect(state.messages).toEqual(before.messages);
    expect(state.usageTotals).toEqual(before.usageTotals);
  });

  it("USAGE_BASELINE sets totals, hit rate, turns and context", () => {
    const state = chatReducer(initialChatState, {
      type: "USAGE_BASELINE",
      totals: USAGE_A,
      cacheHitRate: 0.5,
      turns: 3,
      context: CONTEXT,
    });
    expect(state.usageTotals).toEqual(USAGE_A);
    expect(state.cacheHitRate).toBe(0.5);
    expect(state.usageTurns).toBe(3);
    expect(state.contextUsage).toEqual(CONTEXT);
  });

  it("USAGE_BASELINE accepts null context and null hit rate (empty session)", () => {
    const state = chatReducer(initialChatState, {
      type: "USAGE_BASELINE",
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      cacheHitRate: null,
      turns: 0,
      context: null,
    });
    expect(state.contextUsage).toBeNull();
    expect(state.cacheHitRate).toBeNull();
  });
});

describe("ContextUsageRing", () => {
  const zeroTotals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  it("renders accent level below 60%", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={{ tokens: 1000, contextWindow: 10000, percent: 30 }} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-accent");
    expect(html).toContain('data-testid="context-usage-ring"');
  });

  it("renders warning level between 60% and 85%", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={{ tokens: 7000, contextWindow: 10000, percent: 70 }} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-warning");
  });

  it("renders danger level above 85%", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={{ tokens: 9000, contextWindow: 10000, percent: 90 }} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-danger");
  });

  it("renders empty grey ring when context is null", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={null} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-empty");
    expect(html).toContain("暂无数据");
  });

  it("renders empty ring when percent is null (just compacted)", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={{ tokens: null, contextWindow: 32768, percent: null }} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-empty");
  });
});

describe("MessageComposer usage ring", () => {
  const fakeModels: ModelSummary[] = [];

  it("renders the ring left of the send button when usage props are provided", () => {
    const html = renderToStaticMarkup(
      <MessageComposer
        disabled={false}
        running={false}
        onSend={() => {}}
        onAbort={() => {}}
        models={fakeModels}
        selectedModel={null}
        onSelectModel={() => {}}
        toolMode="off"
        onToolModeChange={() => {}}
        thinkingLevel="off"
        onThinkingLevelChange={() => {}}
        contextUsage={CONTEXT}
        usageTotals={USAGE_A}
        cacheHitRate={0.25}
      />,
    );
    expect(html).toContain('data-testid="context-usage-ring"');
    // 圆环在发送按钮之前
    expect(html.indexOf('data-testid="context-usage-ring"')).toBeLessThan(html.indexOf('aria-label="发送消息"'));
  });

  it("omits the ring when usage props are absent", () => {
    const html = renderToStaticMarkup(
      <MessageComposer
        disabled={false}
        running={false}
        onSend={() => {}}
        onAbort={() => {}}
        models={fakeModels}
        selectedModel={null}
        onSelectModel={() => {}}
        toolMode="off"
        onToolModeChange={() => {}}
        thinkingLevel="off"
        onThinkingLevelChange={() => {}}
      />,
    );
    expect(html).not.toContain('data-testid="context-usage-ring"');
  });
});

describe("MessageList turn usage line", () => {
  it("renders usage line under assistant card with cache metrics", () => {
    const messages = [
      { id: "u1", role: "user" as const, content: "问", timestamp: "", streaming: false },
      { id: "a1", role: "assistant" as const, content: "答", timestamp: "", streaming: false },
    ];
    const timeline: ChatTimelineItem[] = [
      { kind: "message", id: "u1" },
      { kind: "message", id: "a1" },
    ];
    const turnUsages = new Map([["a1", USAGE_A]]);

    const html = renderToStaticMarkup(
      <MessageList
        messages={messages}
        historyEntries={[]}
        timeline={timeline}
        toolCalls={new Map()}
        planItems={[]}
        attachments={[]}
        thinking=""
        collapsedThinkingBlocks={new Set()}
        onToggleThinking={() => {}}
        recovering={false}
        reducedMotion
        turnUsages={turnUsages}
      />,
    );
    expect(html).toContain("↑100 ↓50 R20 W10");
  });

  it("omits cache metrics when both are zero", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, content: "答", timestamp: "", streaming: false },
    ];
    const timeline: ChatTimelineItem[] = [{ kind: "message", id: "a1" }];
    const turnUsages = new Map([["a1", USAGE_B]]);

    const html = renderToStaticMarkup(
      <MessageList
        messages={messages}
        historyEntries={[]}
        timeline={timeline}
        toolCalls={new Map()}
        planItems={[]}
        attachments={[]}
        thinking=""
        collapsedThinkingBlocks={new Set()}
        onToggleThinking={() => {}}
        recovering={false}
        reducedMotion
        turnUsages={turnUsages}
      />,
    );
    expect(html).toContain("↑200 ↓80");
    expect(html).not.toContain("R0 W0");
  });

  it("does not render usage line for messages without data (history)", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, content: "答", timestamp: "", streaming: false },
    ];
    const timeline: ChatTimelineItem[] = [{ kind: "message", id: "a1" }];

    const html = renderToStaticMarkup(
      <MessageList
        messages={messages}
        historyEntries={[]}
        timeline={timeline}
        toolCalls={new Map()}
        planItems={[]}
        attachments={[]}
        thinking=""
        collapsedThinkingBlocks={new Set()}
        onToggleThinking={() => {}}
        recovering={false}
        reducedMotion
        turnUsages={new Map()}
      />,
    );
    expect(html).not.toContain("turn-usage-line");
  });
});
