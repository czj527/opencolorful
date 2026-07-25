import type { ChatMessage, ChatTimelineItem } from "./chat-state.js";

export interface HistoryEntryLike {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export function sameMessage(
  left: { readonly role: string; readonly content: string },
  right: { readonly role: string; readonly content: string },
): boolean {
  return left.role === right.role && left.content === right.content;
}

/**
 * 派生与 MessageList 实际渲染一致的用户消息序列。
 * MessageList 对「JSONL 历史 + 实时消息」做去重合并：被 timeline 引用的实时消息
 * 会从历史中移除；不在 timeline 中的实时消息若已出现在可见历史里也不重复渲染。
 * 时间线导航的锚点必须指向 DOM 中真实存在的 data-anchor，因此派生逻辑必须与
 * MessageList 的合并规则保持一致（可见历史 id 为 history-<可见序号>）。
 */
export function deriveRenderableUserMessages(
  historyEntries: readonly HistoryEntryLike[],
  messages: readonly ChatMessage[],
  timeline: readonly ChatTimelineItem[],
): ChatMessage[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const timelineMessageIds = new Set(
    timeline.filter((item) => item.kind === "message").map((item) => item.id),
  );

  const matchedHistoryIndexes = new Set<number>();
  let historyCursor = historyEntries.length - 1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind !== "message") continue;
    const message = messagesById.get(item.id);
    if (!message) continue;
    for (let historyIndex = historyCursor; historyIndex >= 0; historyIndex -= 1) {
      if (sameMessage(historyEntries[historyIndex]!, message)) {
        matchedHistoryIndexes.add(historyIndex);
        historyCursor = historyIndex - 1;
        break;
      }
    }
  }

  const visibleHistory = historyEntries.filter((_, index) => !matchedHistoryIndexes.has(index));

  const historyUserMessages: ChatMessage[] = [];
  visibleHistory.forEach((entry, index) => {
    if (entry.role !== "user") return;
    historyUserMessages.push({
      id: `history-${index}`,
      role: "user",
      content: entry.content,
      timestamp: "",
      streaming: false,
    });
  });

  const untimedMessages = messages.filter((message) => !timelineMessageIds.has(message.id));
  const representedUntimed = new Set<number>();
  const missingUntimedUserMessages: ChatMessage[] = [];
  for (const message of untimedMessages) {
    const index = visibleHistory.findIndex((entry, candidateIndex) =>
      !representedUntimed.has(candidateIndex) && sameMessage(entry, message));
    if (index === -1) {
      if (message.role === "user") missingUntimedUserMessages.push(message);
    } else {
      representedUntimed.add(index);
    }
  }

  const timelineUserMessages: ChatMessage[] = [];
  for (const item of timeline) {
    if (item.kind !== "message") continue;
    const message = messagesById.get(item.id);
    if (message !== undefined && message.role === "user") {
      timelineUserMessages.push(message);
    }
  }

  return [...historyUserMessages, ...missingUntimedUserMessages, ...timelineUserMessages];
}
