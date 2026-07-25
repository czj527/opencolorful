import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CHAT_COMMANDS,
  buildHelpCardLines,
  executeCommand,
  extractCommandQuery,
  filterCommands,
  parseCommandName,
  type CommandExecutorContext,
} from "./commands.js";
import { chatReducer, initialChatState, type ChatTimelineItem, type CommandCard, type CompactionCard } from "./chat-state.js";
import { MessageComposer } from "./MessageComposer.jsx";
import { MessageList } from "./MessageList.js";
import type { ModelSummary, PlatformEventEnvelope } from "../../lib/types.js";

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

const fakeModels: ModelSummary[] = [];

function renderComposer(extra?: Partial<Parameters<typeof MessageComposer>[0]>): string {
  return renderToStaticMarkup(
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
      {...extra}
    />,
  );
}

describe("commands registry", () => {
  it("contains the five v1 commands with Chinese descriptions", () => {
    expect(CHAT_COMMANDS.map((c) => c.name)).toEqual(["help", "compact", "new", "abort", "clear"]);
    for (const command of CHAT_COMMANDS) {
      expect(command.usage.startsWith("/")).toBe(true);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("parseCommandName parses slash-prefixed input", () => {
    expect(parseCommandName("/help")).toBe("help");
    expect(parseCommandName("/compact")).toBe("compact");
    expect(parseCommandName(" /abort ")).toBe("abort");
    expect(parseCommandName("hello")).toBeNull();
    expect(parseCommandName("/unknown")).toBeNull();
  });

  it("filterCommands filters by prefix case-insensitively", () => {
    expect(filterCommands("").map((c) => c.name)).toHaveLength(5);
    expect(filterCommands("c").map((c) => c.name)).toEqual(["compact", "clear"]);
    expect(filterCommands("CO").map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands("zz")).toEqual([]);
    expect(filterCommands("h").map((c) => c.name)).toEqual(["help"]);
  });

  it("extractCommandQuery only triggers on leading slash without whitespace", () => {
    expect(extractCommandQuery("/")).toBe("");
    expect(extractCommandQuery("/he")).toBe("he");
    expect(extractCommandQuery("hello")).toBeNull();
    expect(extractCommandQuery("/help me")).toBeNull();
  });

  it("buildHelpCardLines lists all commands", () => {
    const lines = buildHelpCardLines();
    expect(lines).toHaveLength(5);
    expect(lines.some((line) => line.includes("/help"))).toBe(true);
    expect(lines.some((line) => line.includes("/compact"))).toBe(true);
  });
});

describe("executeCommand", () => {
  function makeContext(overrides?: Partial<CommandExecutorContext>): CommandExecutorContext {
    return {
      running: false,
      onCompact: async () => ({ kind: "none" }),
      onNewSession: () => {},
      onAbort: () => {},
      ...overrides,
    };
  }

  it("/help returns a help card listing all commands", async () => {
    const outcome = await executeCommand("help", makeContext());
    expect(outcome.kind).toBe("card");
    if (outcome.kind === "card") {
      expect(outcome.title).toBe("可用命令");
      expect(outcome.lines).toHaveLength(5);
      expect(outcome.tone).toBe("info");
    }
  });

  it("/compact delegates to onCompact", async () => {
    const outcome = await executeCommand("compact", makeContext({
      onCompact: async () => ({ kind: "card", title: "压缩失败", lines: ["会话正在生成，无法压缩"], tone: "error" }),
    }));
    expect(outcome.kind).toBe("card");
    if (outcome.kind === "card") {
      expect(outcome.lines[0]).toBe("会话正在生成，无法压缩");
      expect(outcome.tone).toBe("error");
    }
  });

  it("/new invokes onNewSession and returns none", async () => {
    let called = 0;
    const outcome = await executeCommand("new", makeContext({ onNewSession: () => { called += 1; } }));
    expect(called).toBe(1);
    expect(outcome.kind).toBe("none");
  });

  it("/abort without running generation returns an info card", async () => {
    let aborted = 0;
    const outcome = await executeCommand("abort", makeContext({
      running: false,
      onAbort: () => { aborted += 1; },
    }));
    expect(aborted).toBe(0);
    expect(outcome.kind).toBe("card");
    if (outcome.kind === "card") {
      expect(outcome.lines[0]).toBe("当前没有进行中的生成");
    }
  });

  it("/abort with running generation invokes onAbort", async () => {
    let aborted = 0;
    const outcome = await executeCommand("abort", makeContext({
      running: true,
      onAbort: () => { aborted += 1; },
    }));
    expect(aborted).toBe(1);
    expect(outcome.kind).toBe("card");
  });

  it("/clear returns clear outcome", async () => {
    const outcome = await executeCommand("clear", makeContext());
    expect(outcome.kind).toBe("clear");
  });
});

describe("chatReducer command cards", () => {
  it("ADD_COMMAND_CARD appends a local card to timeline", () => {
    const state = chatReducer(initialChatState, {
      type: "ADD_COMMAND_CARD",
      title: "可用命令",
      lines: ["/help — 显示可用命令帮助"],
    });
    expect(state.commandCards.size).toBe(1);
    const card = state.commandCards.get("cmd-card-1");
    expect(card?.title).toBe("可用命令");
    expect(card?.tone).toBe("info");
    expect(state.timeline[state.timeline.length - 1]).toEqual({ kind: "command", id: "cmd-card-1" });
  });

  it("command cards survive PROMPT_PENDING and PROMPT_SENT across turns", () => {
    let state = chatReducer(initialChatState, {
      type: "ADD_COMMAND_CARD",
      title: "可用命令",
      lines: ["x"],
    });
    state = chatReducer(state, { type: "PROMPT_PENDING", userContent: "问" });
    expect(state.timeline.some((item) => item.kind === "command")).toBe(true);
    state = chatReducer(state, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    const kinds = state.timeline.map((item) => item.kind);
    expect(kinds).toContain("command");
    expect(kinds[kinds.length - 1]).toBe("message");
    expect(state.commandCards.size).toBe(1);
  });
});

describe("chatReducer compaction cards", () => {
  it("session.compacting inserts a pending compaction card on a control stream", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacting", { reason: "manual" }, 1, "ctrl-abc"),
    });
    expect(state.compactionCards.size).toBe(1);
    const card = state.compactionCards.get("compaction-evt-ctrl-abc-1");
    expect(card?.status).toBe("compacting");
    expect(state.activeCompactionId).toBe("compaction-evt-ctrl-abc-1");
    expect(state.timeline.some((item) => item.kind === "compaction")).toBe(true);
  });

  it("session.compacted updates the pending card with tokens and summary", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacting", { reason: "manual" }, 1, "ctrl-abc"),
    });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacted", { reason: "manual", tokensBefore: 12000, tokensAfter: 3000, summary: "摘要内容" }, 2, "ctrl-abc"),
    });
    const card = state.compactionCards.get("compaction-evt-ctrl-abc-1");
    expect(card?.status).toBe("completed");
    expect(card?.tokensBefore).toBe(12000);
    expect(card?.tokensAfter).toBe(3000);
    expect(card?.summary).toBe("摘要内容");
    expect(state.activeCompactionId).toBeNull();
    // 不重复插入 timeline
    expect(state.timeline.filter((item) => item.kind === "compaction")).toHaveLength(1);
  });

  it("session.compacted with errorMessage marks the card as failed", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacting", { reason: "manual" }, 1, "ctrl-abc"),
    });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacted", { reason: "manual", aborted: true, errorMessage: "压缩被中断" }, 2, "ctrl-abc"),
    });
    const card = state.compactionCards.get("compaction-evt-ctrl-abc-1");
    expect(card?.status).toBe("failed");
    expect(card?.errorMessage).toBe("压缩被中断");
  });

  it("session.compacted without a pending card inserts a standalone result card", () => {
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacted", { reason: "manual", tokensBefore: 100, tokensAfter: 50 }, 1, "ctrl-xyz"),
    });
    const card = state.compactionCards.get("compaction-evt-ctrl-xyz-1");
    expect(card?.status).toBe("completed");
    expect(state.timeline.some((item) => item.kind === "compaction")).toBe(true);
  });

  it("control stream events are not dropped by the current-stream filter", () => {
    // currentStreamId 为 st1，compact 事件在 ctrl- 流上，必须被处理而不是丢弃
    let state = chatReducer(initialChatState, { type: "PROMPT_SENT", streamId: "st1", userContent: "问" });
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacting", { reason: "manual" }, 1, "ctrl-other"),
    });
    expect(state.compactionCards.size).toBe(1);
    // 同时推进 ctrl 流游标，重复事件被去重
    state = chatReducer(state, {
      type: "EVENT",
      event: makeEvent("session.compacting", { reason: "manual" }, 1, "ctrl-other"),
    });
    expect(state.compactionCards.size).toBe(1);
  });
});

describe("MessageList command and compaction cards", () => {
  const baseProps = {
    messages: [],
    historyEntries: [],
    toolCalls: new Map(),
    planItems: [],
    attachments: [],
    thinking: "",
    collapsedThinkingBlocks: new Set<string>(),
    onToggleThinking: () => {},
    recovering: false,
    reducedMotion: true,
  };

  it("renders a command card with weakened style", () => {
    const card: CommandCard = { id: "cmd-card-1", title: "可用命令", lines: ["/help — 帮助"], tone: "info" };
    const timeline: ChatTimelineItem[] = [{ kind: "command", id: "cmd-card-1" }];
    const html = renderToStaticMarkup(
      <MessageList {...baseProps} timeline={timeline} commandCards={new Map([[card.id, card]])} />,
    );
    expect(html).toContain("command-card");
    expect(html).toContain("可用命令");
    expect(html).toContain("/help — 帮助");
  });

  it("renders an error-tone command card", () => {
    const card: CommandCard = { id: "cmd-card-2", title: "压缩失败", lines: ["会话正在生成，无法压缩"], tone: "error" };
    const timeline: ChatTimelineItem[] = [{ kind: "command", id: "cmd-card-2" }];
    const html = renderToStaticMarkup(
      <MessageList {...baseProps} timeline={timeline} commandCards={new Map([[card.id, card]])} />,
    );
    expect(html).toContain("command-card-error");
    expect(html).toContain("会话正在生成，无法压缩");
  });

  it("renders a compacting placeholder card", () => {
    const card: CompactionCard = {
      id: "compaction-1",
      status: "compacting",
      tokensBefore: null,
      tokensAfter: null,
      summary: null,
      errorMessage: null,
    };
    const timeline: ChatTimelineItem[] = [{ kind: "compaction", id: card.id }];
    const html = renderToStaticMarkup(
      <MessageList {...baseProps} timeline={timeline} compactionCards={new Map([[card.id, card]])} />,
    );
    expect(html).toContain("compaction-card");
    expect(html).toContain("正在压缩会话上下文…");
  });

  it("renders a completed compaction card with tokens and summary", () => {
    const card: CompactionCard = {
      id: "compaction-2",
      status: "completed",
      tokensBefore: 12000,
      tokensAfter: 3000,
      summary: "压缩摘要",
      errorMessage: null,
    };
    const timeline: ChatTimelineItem[] = [{ kind: "compaction", id: card.id }];
    const html = renderToStaticMarkup(
      <MessageList {...baseProps} timeline={timeline} compactionCards={new Map([[card.id, card]])} />,
    );
    expect(html).toContain("上下文已压缩");
    expect(html).toContain("12000 → 3000 tokens");
    expect(html).toContain("压缩摘要");
  });

  it("renders a failed compaction card with error message", () => {
    const card: CompactionCard = {
      id: "compaction-3",
      status: "failed",
      tokensBefore: null,
      tokensAfter: null,
      summary: null,
      errorMessage: "压缩被中断",
    };
    const timeline: ChatTimelineItem[] = [{ kind: "compaction", id: card.id }];
    const html = renderToStaticMarkup(
      <MessageList {...baseProps} timeline={timeline} compactionCards={new Map([[card.id, card]])} />,
    );
    expect(html).toContain("compaction-card-failed");
    expect(html).toContain("压缩未完成");
    expect(html).toContain("压缩被中断");
  });
});

describe("MessageComposer command panel", () => {
  it("does not render the command panel without onExecuteCommand", () => {
    const html = renderComposer();
    expect(html).not.toContain('data-testid="command-panel"');
  });

  it("does not render the command panel on initial empty input", () => {
    const html = renderComposer({ onExecuteCommand: () => {} });
    expect(html).not.toContain('data-testid="command-panel"');
  });

  it("keeps existing composer aria-labels intact with command support", () => {
    const html = renderComposer({ onExecuteCommand: () => {} });
    expect(html).toContain('aria-label="消息输入"');
    expect(html).toContain('aria-label="发送消息"');
    expect(html).toContain("/ 打开命令");
  });
});
