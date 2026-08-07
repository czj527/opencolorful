import type { SessionView, ModelSummary } from "../lib/types.js";
import type { ChatState } from "../features/chat/chat-state.js";
import type { CommandName } from "../features/chat/commands.js";
import { MessageList } from "../features/chat/MessageList.jsx";
import { MessageComposer } from "../features/chat/MessageComposer.jsx";
import { ChatTimelineNav } from "../features/chat/ChatTimelineNav.jsx";
import { SubagentCardList, type SubagentParentRequestAction } from "../features/subagents/SubagentCard.jsx";
import type { SubagentCardData } from "../features/subagents/use-subagent-threads.js";
import { deriveRenderableUserMessages } from "../features/chat/timeline-turns.js";
import { useChatScroll } from "../features/chat/use-chat-scroll.js";
import { useMemo } from "react";
import { MessageSquare, Settings, ListTree } from "lucide-react";
import { IconButton } from "./ui/IconButton.js";
import styles from "./ChatPane.module.css";
import "../features/chat/chat.css";

const EMPTY_HISTORY: readonly { role: "user" | "assistant"; content: string }[] = [];

interface ChatPaneProps {
  readonly session: SessionView | null;
  readonly chat: ChatState;
  readonly models: ModelSummary[];
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  /** 会话命令执行回调（可选，缺省时命令面板不可用） */
  readonly onExecuteCommand?: (name: CommandName) => void;
  readonly onToggleThinking: (id: string) => void;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly onToolModeChange?: (mode: string) => void;
  readonly onThinkingLevelChange?: (level: string) => void;
  readonly sseConnected: boolean;
  readonly onSettingsClick?: () => void;
  readonly reducedMotion?: boolean;
  readonly showThinking?: boolean;
  readonly showToolCalls?: boolean;
  /** 时间线栏是否可见（窄屏自动隐藏且不可展开） */
  readonly timelineVisible?: boolean;
  /** 切换时间线显隐 */
  readonly onToggleTimeline?: () => void;
  /** 是否窄屏（自动隐藏时间线） */
  readonly narrowScreen?: boolean;
  /** Phase 14（§21.1）：主对话 Subagent 卡片（稳定展示，点击打开右侧面板） */
  readonly subagentCards?: readonly SubagentCardData[];
  readonly onOpenSubagent?: (threadId: SubagentCardData["threadId"]) => void;
  /** 只读请求：向主对话发结构化消息，不直接控制 Subagent */
  readonly onRequestParentAction?: (
    threadId: SubagentCardData["threadId"],
    action: SubagentParentRequestAction,
    title: string,
  ) => void;
}

const headerClass = styles.header ?? "";
const titleClass = styles.title ?? "";
const titleTextClass = styles.titleText ?? "";
const headerActionsClass = styles.headerActions ?? "";
const errorBarClass = styles.errorBar ?? "";
const bodyClass = styles.body ?? "";
const bodyMainClass = styles.bodyMain ?? "";
const emptyWrapClass = styles.emptyWrap ?? "";
const emptyIconClass = styles.emptyIcon ?? "";
const emptyTitleClass = styles.emptyTitle ?? "";
const emptyHintClass = styles.emptyHint ?? "";

export function ChatPane({
  session,
  chat,
  models,
  onSend,
  onAbort,
  onExecuteCommand,
  onToggleThinking,
  onSelectModel,
  sseConnected,
  onSettingsClick,
  reducedMotion,
  onToolModeChange,
  onThinkingLevelChange,
  showThinking = true,
  showToolCalls = true,
  timelineVisible = true,
  onToggleTimeline,
  narrowScreen = false,
  subagentCards,
  onOpenSubagent,
  onRequestParentAction,
}: ChatPaneProps) {
  const scroll = useChatScroll(reducedMotion ?? false);
  const historyEntries = session?.messageEntries ?? EMPTY_HISTORY;
  const navMessages = useMemo(
    () => deriveRenderableUserMessages(historyEntries, chat.messages, chat.timeline),
    [historyEntries, chat.messages, chat.timeline],
  );

  if (!session) {
    return (
      <main className="app-chat" role="main" aria-label="聊天区域">
        <div className={`empty-state ${emptyWrapClass}`.trim()}>
          <MessageSquare size={32} strokeWidth={1.5} aria-hidden="true" className={emptyIconClass} />
          <div className={emptyTitleClass}>选择一个会话开始对话</div>
          <div className={emptyHintClass}>从左侧面板选择或创建新会话</div>
        </div>
      </main>
    );
  }

  const running = chat.status === "running";
  const showTimeline = timelineVisible && !narrowScreen && chat.messages.length > 0;
  const sseLabel = sseConnected ? "事件流已连接" : "事件流未连接";

  return (
    <main className="app-chat" role="main" aria-label="聊天区域">
      <div className={headerClass}>
        <div className={titleClass}>
          <span className={titleTextClass}>{session.title}</span>
        </div>
        <div className={headerActionsClass}>
          {!narrowScreen && (
            <IconButton
              icon={<ListTree size={14} aria-hidden="true" />}
              label={timelineVisible ? "隐藏时间线" : "显示时间线"}
              active={timelineVisible}
              {...(onToggleTimeline !== undefined ? { onClick: onToggleTimeline } : {})}
            />
          )}
          <span
            className={`status-dot ${sseConnected ? "online" : "stopped"}`}
            title={sseLabel}
            aria-label={sseLabel}
          />
          {onSettingsClick && (
            <IconButton
              icon={<Settings size={14} aria-hidden="true" />}
              label="设置中心"
              onClick={onSettingsClick}
            />
          )}
        </div>
      </div>

      {chat.error && (
        <div role="alert" className={errorBarClass}>
          {chat.error}
        </div>
      )}

      <div className={bodyClass}>
        <div className={bodyMainClass}>
          <MessageList
            messages={chat.messages}
            historyEntries={historyEntries}
            timeline={chat.timeline}
            toolCalls={chat.toolCalls}
            planItems={chat.planItems}
            attachments={chat.attachments}
            thinking={chat.thinking}
            collapsedThinkingBlocks={chat.collapsedThinkingBlocks}
            onToggleThinking={onToggleThinking}
            recovering={!sseConnected && running}
            reducedMotion={reducedMotion ?? false}
            showThinking={showThinking ?? true}
            showToolCalls={showToolCalls ?? true}
            turnUsages={chat.turnUsages}
            commandCards={chat.commandCards}
            compactionCards={chat.compactionCards}
            scroll={scroll}
          />

          {subagentCards !== undefined && subagentCards.length > 0 && onOpenSubagent !== undefined && (
            <SubagentCardList
              cards={subagentCards}
              reducedMotion={reducedMotion ?? false}
              onOpen={onOpenSubagent}
              onRequestParentAction={onRequestParentAction ?? (() => {})}
            />
          )}

          <MessageComposer
            disabled={false}
            running={running}
            onSend={onSend}
            onAbort={onAbort}
            {...(onExecuteCommand !== undefined ? { onExecuteCommand } : {})}
            models={models}
            selectedModel={session.model}
            onSelectModel={onSelectModel}
            toolMode={session.toolMode}
            onToolModeChange={onToolModeChange ?? (() => {})}
            thinkingLevel={session.thinkingLevel}
            onThinkingLevelChange={onThinkingLevelChange ?? (() => {})}
            contextUsage={chat.contextUsage}
            usageTotals={chat.usageTotals}
            cacheHitRate={chat.cacheHitRate}
          />
        </div>

        {showTimeline && (
          <ChatTimelineNav
            messages={navMessages}
            activeAnchor={scroll.activeAnchor}
            onSelectTurn={scroll.scrollToAnchor}
          />
        )}
      </div>
    </main>
  );
}
