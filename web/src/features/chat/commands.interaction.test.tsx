/**
 * 示范用例：把原 commands.test.tsx 中基于 renderToStaticMarkup 的静态断言，
 * 改造为 @testing-library/react 的 render + screen + fireEvent 写法，
 * 证明在 happy-dom 下可以测交互态（输入 → 命令面板出现 → 点击执行 → 回调触发）。
 *
 * 保留原断言意图（命令面板在初始空输入时不出现、输入 / 后出现、点击命令触发回调），
 * 但通过真实 DOM 事件驱动，更贴近用户行为。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { MessageComposer } from "./MessageComposer.js";
import { MessageList } from "./MessageList.js";
import type { CommandCard, CompactionCard } from "./chat-state.js";
import type { ChatTimelineItem } from "./chat-state.js";
import { renderWithTheme } from "../../test/render.js";

const baseComposerProps = {
  disabled: false,
  running: false,
  onSend: () => {},
  onAbort: () => {},
  models: [],
  selectedModel: null,
  onSelectModel: () => {},
  toolMode: "off",
  onToolModeChange: () => {},
  thinkingLevel: "off",
  onThinkingLevelChange: () => {},
} as const;

const baseListProps = {
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

describe("MessageComposer 命令面板交互（render + fireEvent 示范）", () => {
  it("初始空输入时不渲染命令面板", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={() => {}} />);
    expect(screen.queryByTestId("command-panel")).toBeNull();
  });

  it("输入 / 后出现命令面板并列出候选项", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={() => {}} />);
    const input = screen.getByLabelText("消息输入");
    fireEvent.change(input, { target: { value: "/" } });
    const panel = screen.getByTestId("command-panel");
    expect(panel).toBeDefined();
    // 五个命令均出现
    expect(screen.getByTestId("command-item-help")).toBeDefined();
    expect(screen.getByTestId("command-item-compact")).toBeDefined();
    expect(screen.getByTestId("command-item-clear")).toBeDefined();
  });

  it("输入 /c 后仅出现 compact/clear 候选", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={() => {}} />);
    const input = screen.getByLabelText("消息输入");
    fireEvent.change(input, { target: { value: "/c" } });
    expect(screen.queryByTestId("command-item-help")).toBeNull();
    expect(screen.getByTestId("command-item-compact")).toBeDefined();
    expect(screen.getByTestId("command-item-clear")).toBeDefined();
  });

  it("点击命令项触发 onExecuteCommand 并清空输入框", () => {
    const onExecuteCommand = vi.fn();
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={onExecuteCommand} />);
    const input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/he" } });
    fireEvent.click(screen.getByTestId("command-item-help"));
    expect(onExecuteCommand).toHaveBeenCalledWith("help");
    expect(input.value).toBe("");
  });

  it("未传入 onExecuteCommand 时不渲染命令面板（即使输入 /）", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} />);
    const input = screen.getByLabelText("消息输入");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.queryByTestId("command-panel")).toBeNull();
  });
});

describe("MessageList 命令/压缩卡片渲染（render + screen 示范）", () => {
  it("渲染 info 命令卡片并展示标题与内容", () => {
    const card: CommandCard = { id: "cmd-card-1", title: "可用命令", lines: ["/help — 帮助"], tone: "info" };
    const timeline: ChatTimelineItem[] = [{ kind: "command", id: card.id }];
    renderWithTheme(
      <MessageList {...baseListProps} timeline={timeline} commandCards={new Map([[card.id, card]])} />,
    );
    expect(screen.getByTestId("command-card-cmd-card-1")).toBeDefined();
    expect(screen.getByText("可用命令")).toBeDefined();
    expect(screen.getByText("/help — 帮助")).toBeDefined();
  });

  it("渲染 error 命令卡片并展示错误文案", () => {
    const card: CommandCard = { id: "cmd-card-2", title: "压缩失败", lines: ["会话正在生成，无法压缩"], tone: "error" };
    const timeline: ChatTimelineItem[] = [{ kind: "command", id: card.id }];
    renderWithTheme(
      <MessageList {...baseListProps} timeline={timeline} commandCards={new Map([[card.id, card]])} />,
    );
    const cardEl = screen.getByTestId("command-card-cmd-card-2");
    expect(cardEl.className).toContain("command-card-error");
    expect(screen.getByText("会话正在生成，无法压缩")).toBeDefined();
  });

  it("渲染 completed 压缩卡片并展示 token 数与摘要", () => {
    const card: CompactionCard = {
      id: "compaction-2",
      status: "completed",
      tokensBefore: 12000,
      tokensAfter: 3000,
      summary: "压缩摘要",
      errorMessage: null,
    };
    const timeline: ChatTimelineItem[] = [{ kind: "compaction", id: card.id }];
    renderWithTheme(
      <MessageList {...baseListProps} timeline={timeline} compactionCards={new Map([[card.id, card]])} />,
    );
    expect(screen.getByText("上下文已压缩")).toBeDefined();
    expect(screen.getByText(/12000/)).toBeDefined();
    expect(screen.getByText(/3000/)).toBeDefined();
    expect(screen.getByText("压缩摘要")).toBeDefined();
  });

  it("渲染 failed 压缩卡片并展示错误信息", () => {
    const card: CompactionCard = {
      id: "compaction-3",
      status: "failed",
      tokensBefore: null,
      tokensAfter: null,
      summary: null,
      errorMessage: "压缩被中断",
    };
    const timeline: ChatTimelineItem[] = [{ kind: "compaction", id: card.id }];
    renderWithTheme(
      <MessageList {...baseListProps} timeline={timeline} compactionCards={new Map([[card.id, card]])} />,
    );
    expect(screen.getByText("压缩未完成")).toBeDefined();
    expect(screen.getByText("压缩被中断")).toBeDefined();
  });
});
