import type { PlatformEventEnvelope } from "../../lib/types.js";

// --- Chat message types ---

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly timestamp: string;
  readonly streaming: boolean;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "running" | "completed" | "error";
  readonly result?: unknown;
  readonly delta?: string;
}

export interface PlanItem {
  readonly id: string;
  readonly text: string;
}

export interface Attachment {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType?: string;
}

export type ChatTimelineItem =
  | { readonly kind: "message"; readonly id: string }
  | { readonly kind: "thinking"; readonly id: string; readonly content?: string }
  | { readonly kind: "tool"; readonly id: string }
  | { readonly kind: "plan"; readonly id: string }
  | { readonly kind: "attachment"; readonly id: string };

export interface ChatState {
  readonly messages: ChatMessage[];
  readonly timeline: ChatTimelineItem[];
  readonly toolCalls: Map<string, ToolCall>;
  readonly planItems: PlanItem[];
  readonly attachments: Attachment[];
  readonly currentStreamId: string | null;
  readonly pendingPrompt: boolean;
  readonly pendingStreamId: string | null;
  /** 每个 stream 的独立 sequence 游标（同一 Session 的每个 stream 从 1 开始） */
  readonly cursors: ReadonlyMap<string, number>;
  readonly thinking: string;
  /** 每个思考块的展开/收起状态：存在=收起，不存在=展开 */
  readonly collapsedThinkingBlocks: ReadonlySet<string>;
  readonly status: "idle" | "running" | "error";
  readonly error: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  timeline: [],
  toolCalls: new Map(),
  planItems: [],
  attachments: [],
  currentStreamId: null,
  pendingPrompt: false,
  pendingStreamId: null,
  cursors: new Map(),
  thinking: "",
  collapsedThinkingBlocks: new Set(),
  status: "idle",
  error: null,
};

/** 读取指定 stream 的游标（WS stream.resume 使用） */
export function getStreamCursor(state: ChatState, streamId: string): number {
  return state.cursors.get(streamId) ?? 0;
}

function appendTimelineItem(
  timeline: readonly ChatTimelineItem[],
  item: ChatTimelineItem,
): ChatTimelineItem[] {
  return timeline.some((existing) => existing.kind === item.kind && existing.id === item.id)
    ? [...timeline]
    : [...timeline, item];
}

// --- Actions ---

export type ChatAction =
  | { type: "RESET" }
  | { type: "LOAD_HISTORY"; state: ChatState }
  | { type: "PROMPT_PENDING"; userContent: string }
  | { type: "PROMPT_SENT"; streamId: string; userContent: string }
  | { type: "EVENT"; event: PlatformEventEnvelope }
  | { type: "EVENT_BATCH"; events: readonly PlatformEventEnvelope[] }
  | { type: "TOGGLE_THINKING"; id: string }
  | { type: "SET_ERROR"; error: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "RESET":
      return { ...initialChatState };

    case "LOAD_HISTORY":
      return action.state;

    case "EVENT_BATCH": {
      let next = state;
      for (const event of action.events) {
        next = chatReducer(next, { type: "EVENT", event });
      }
      return next;
    }

    case "PROMPT_PENDING": {
      const pendingMessage: ChatMessage = {
        id: "user-pending",
        role: "user",
        content: action.userContent,
        timestamp: new Date().toISOString(),
        streaming: false,
      };
      return {
        ...state,
        messages: [
          ...state.messages.filter((message) => message.id !== pendingMessage.id),
          pendingMessage,
        ],
        timeline: [{ kind: "message", id: pendingMessage.id }],
        currentStreamId: null,
        pendingPrompt: true,
        pendingStreamId: null,
        status: "running",
        error: null,
        thinking: "",
        collapsedThinkingBlocks: new Set(),
        toolCalls: new Map(),
        planItems: [],
        attachments: [],
      };
    }

    case "PROMPT_SENT": {
      const cursors = new Map(state.cursors);
      const earlyEventsReceived = state.pendingStreamId === action.streamId || cursors.has(action.streamId);
      if (!earlyEventsReceived) cursors.set(action.streamId, 0);
      const userMessage: ChatMessage = {
        id: `user-${action.streamId}`,
        role: "user",
        content: action.userContent,
        timestamp: new Date().toISOString(),
        streaming: false,
      };
      const pendingIndex = state.messages.findIndex((message) => message.id === "user-pending");
      const messages = pendingIndex !== -1
        ? state.messages.map((message, index) => index === pendingIndex ? userMessage : message)
        : state.messages.some((message) => message.id === userMessage.id)
          ? state.messages
          : earlyEventsReceived
            ? [userMessage, ...state.messages]
            : [...state.messages, userMessage];
      const userTimelineItem: ChatTimelineItem = { kind: "message", id: userMessage.id };
      const earlyTimeline = state.timeline.filter((item) =>
        !(item.kind === "message" && (item.id === "user-pending" || item.id === userMessage.id)));
      return {
        ...state,
        currentStreamId: action.streamId,
        pendingPrompt: false,
        pendingStreamId: null,
        cursors,
        messages,
        timeline: earlyEventsReceived
          ? [userTimelineItem, ...earlyTimeline]
          : [userTimelineItem],
        status: "running",
        error: null,
        thinking: earlyEventsReceived ? state.thinking : "",
        toolCalls: earlyEventsReceived ? state.toolCalls : new Map(),
        planItems: earlyEventsReceived ? state.planItems : [],
        attachments: earlyEventsReceived ? state.attachments : [],
      };
    }

    case "EVENT": {
      const event = action.event;

      // 只处理当前 stream 的事件：旧 stream 的重放事件不污染当前视图
      if (event.streamId !== null && state.currentStreamId !== null && event.streamId !== state.currentStreamId) {
        return state;
      }
      if (event.streamId !== null && state.pendingPrompt && state.currentStreamId === null) {
        if (state.pendingStreamId !== null && event.streamId !== state.pendingStreamId) return state;
        // pending 期间忽略已经见过的旧 stream；第一个新 stream 成为本次 Prompt 的候选流。
        if (state.pendingStreamId === null && state.cursors.has(event.streamId)) return state;
      }

      // 按 stream 游标去重/乱序丢弃
      const streamKey = event.streamId ?? "";
      const cursor = state.cursors.get(streamKey) ?? 0;
      if (event.sequence <= cursor) return state;

      const cursors = new Map(state.cursors);
      cursors.set(streamKey, event.sequence);
      const base = {
        ...state,
        cursors,
        pendingStreamId: state.pendingPrompt && state.pendingStreamId === null && event.streamId !== null
          ? event.streamId
          : state.pendingStreamId,
      };

      switch (event.type) {
        case "session.status": {
          const payload = event.payload as { status: string };
          if (payload.status === "idle") {
            return { ...base, status: "idle" };
          }
          if (payload.status === "running") {
            return { ...base, status: "running" };
          }
          return base;
        }

        case "message.started":
          return {
            ...base,
            messages: [
              ...base.messages,
              {
                id: event.eventId,
                role: "assistant" as const,
                content: "",
                timestamp: event.timestamp,
                streaming: true,
              },
            ],
            timeline: appendTimelineItem(base.timeline, { kind: "message", id: event.eventId }),
          };

        case "message.delta": {
          const payload = event.payload as { role: string; delta: string };
          // 不因 role 过滤：服务端可能以非 assistant 角色发送文本增量
          const lastMessage = base.messages[base.messages.length - 1];
          // message.started 可能未抵达或延迟（取决于 PI SDK/模型），
          // 此时自动创建一个 streaming message，防止全部 delta 被丢弃
          if (!lastMessage || !lastMessage.streaming) {
            const message: ChatMessage = {
              id: event.eventId,
              role: "assistant",
              content: payload.delta,
              timestamp: event.timestamp,
              streaming: true,
            };
            return {
              ...base,
              messages: [...base.messages, message],
              timeline: appendTimelineItem(base.timeline, { kind: "message", id: event.eventId }),
            };
          }
          return {
            ...base,
            messages: [
              ...base.messages.slice(0, -1),
              { ...lastMessage, content: lastMessage.content + payload.delta },
            ],
          };
        }

        case "thinking.delta": {
          const payload = event.payload as { delta: string };
          return {
            ...base,
            thinking: base.thinking + payload.delta,
            timeline: appendTimelineItem(base.timeline, { kind: "thinking", id: `thinking-${streamKey}` }),
          };
        }

        case "message.completed": {
          const payload = event.payload as { role: string; content: string };
          const lastMessage = base.messages[base.messages.length - 1];
          if (lastMessage?.streaming) {
            return {
              ...base,
              messages: [
                ...base.messages.slice(0, -1),
                { ...lastMessage, content: payload.content, streaming: false },
              ],
            };
          }
          return {
            ...base,
            messages: [
              ...base.messages,
              {
                id: event.eventId,
                role: payload.role as "assistant",
                content: payload.content,
                timestamp: event.timestamp,
                streaming: false,
              },
            ],
            timeline: appendTimelineItem(base.timeline, { kind: "message", id: event.eventId }),
          };
        }

        case "tool.started": {
          const payload = event.payload as { toolCallId: string; toolName: string };
          const newToolCalls = new Map(base.toolCalls);
          newToolCalls.set(payload.toolCallId, {
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            status: "running",
          });
          return {
            ...base,
            toolCalls: newToolCalls,
            timeline: appendTimelineItem(base.timeline, { kind: "tool", id: payload.toolCallId }),
          };
        }

        case "tool.delta": {
          const payload = event.payload as { toolCallId: string; delta: string };
          const existing = base.toolCalls.get(payload.toolCallId);
          if (!existing) return base;
          const newToolCalls = new Map(base.toolCalls);
          newToolCalls.set(payload.toolCallId, { ...existing, delta: (existing.delta ?? "") + payload.delta });
          return { ...base, toolCalls: newToolCalls };
        }

        case "tool.completed": {
          const payload = event.payload as { toolCallId: string; result: unknown; isError: boolean };
          const existing = base.toolCalls.get(payload.toolCallId);
          if (!existing) return base;
          const newToolCalls = new Map(base.toolCalls);
          newToolCalls.set(payload.toolCallId, {
            ...existing,
            status: payload.isError ? "error" : "completed",
            result: payload.result,
          });
          return { ...base, toolCalls: newToolCalls };
        }

        case "plan.updated": {
          const payload = event.payload as { items: string[] };
          return {
            ...base,
            planItems: payload.items.map((text, i) => ({ id: `plan-${i}`, text })),
            timeline: appendTimelineItem(base.timeline, { kind: "plan", id: `plan-${streamKey}` }),
          };
        }

        case "attachment.available": {
          const payload = event.payload as { attachmentId: string; name: string; mimeType?: string };
          return {
            ...base,
            attachments: [
              ...base.attachments,
              {
                attachmentId: payload.attachmentId,
                name: payload.name,
                ...(payload.mimeType !== undefined ? { mimeType: payload.mimeType } : {}),
              },
            ],
            timeline: appendTimelineItem(base.timeline, { kind: "attachment", id: payload.attachmentId }),
          };
        }

        case "error": {
          const payload = event.payload as { code: string; message: string; retryable: boolean };
          return { ...base, status: "error", error: payload.message };
        }

        case "turn.completed":
          return { ...base, status: "idle" };

        default:
          return base;
      }
    }

    case "TOGGLE_THINKING": {
      const next = new Set(state.collapsedThinkingBlocks);
      if (next.has(action.id)) {
        next.delete(action.id);
      } else {
        next.add(action.id);
      }
      return { ...state, collapsedThinkingBlocks: next };
    }

    case "SET_ERROR":
      return {
        ...state,
        currentStreamId: null,
        pendingPrompt: false,
        pendingStreamId: null,
        status: "error",
        error: action.error,
      };
  }
}

// --- Helpers ---

export function sanitizeMarkdown(text: string): string {
  // Remove javascript: URLs (handle nested parens)
  return text.replace(/\[([^\]]*)\]\(javascript:[^\s]*\)/gi, "$1");
}

export function isSafeUrl(url: string): boolean {
  if (/^\s*javascript:/i.test(url)) return false;
  if (/^\s*data:/i.test(url)) return false;
  if (/^\s*vbscript:/i.test(url)) return false;
  // Must have a scheme or start with / or #
  if (!/^(https?:|mailto:|\/|#)/i.test(url.trim())) return false;
  try {
    const parsed = new URL(url, "http://localhost");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// --- History reconstruction ---

export interface HistoryMessageEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly { toolCallId: string; toolName: string; status: "completed" | "error"; result?: string }[];
}

/**
 * 从 Session 历史 messageEntries 重建 ChatState。
 * 按条目顺序构建 messages、timeline、toolCalls 和 thinking，
 * DOM 顺序：用户消息 → (思考) → 工具卡片 → 助手回答。
 */
export function buildChatStateFromHistory(entries: readonly HistoryMessageEntry[]): ChatState {
  const messages: ChatMessage[] = [];
  const timeline: ChatTimelineItem[] = [];
  const toolCalls = new Map<string, ToolCall>();
  let thinkingText = "";
  let entryIndex = 0;

  for (const entry of entries) {
    const msgId = `history-msg-${entryIndex}`;

    if (entry.role === "user") {
      messages.push({
        id: msgId,
        role: "user",
        content: entry.content,
        timestamp: "",
        streaming: false,
      });
      timeline.push({ kind: "message", id: msgId });
    } else {
      // assistant: thinking block → tool cards → message
      if (entry.thinking) {
        const thinkingId = `history-thinking-${entryIndex}`;
        thinkingText = entry.thinking;
        timeline.push({ kind: "thinking", id: thinkingId, content: entry.thinking });
      }

      if (entry.toolCalls && entry.toolCalls.length > 0) {
        for (const tc of entry.toolCalls) {
          toolCalls.set(tc.toolCallId, {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            status: tc.status,
            result: tc.result,
          });
          timeline.push({ kind: "tool", id: tc.toolCallId });
        }
      }

      messages.push({
        id: msgId,
        role: "assistant",
        content: entry.content,
        timestamp: "",
        streaming: false,
      });
      timeline.push({ kind: "message", id: msgId });
    }

    entryIndex += 1;
  }

  return {
    ...initialChatState,
    messages,
    timeline,
    toolCalls,
    thinking: thinkingText,
    collapsedThinkingBlocks: new Set(),
    status: "idle",
  };
}
