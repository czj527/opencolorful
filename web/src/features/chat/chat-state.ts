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
  | { readonly kind: "thinking"; readonly id: string }
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
  readonly thinkingCollapsed: boolean;
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
  thinkingCollapsed: true,
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
  | { type: "PROMPT_PENDING"; userContent: string }
  | { type: "PROMPT_SENT"; streamId: string; userContent: string }
  | { type: "EVENT"; event: PlatformEventEnvelope }
  | { type: "EVENT_BATCH"; events: readonly PlatformEventEnvelope[] }
  | { type: "TOGGLE_THINKING" }
  | { type: "SET_ERROR"; error: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "RESET":
      return { ...initialChatState };

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
            timeline: appendTimelineItem(base.timeline, { kind: "message", id: `msg-${streamKey}` }),
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
              timeline: appendTimelineItem(base.timeline, { kind: "message", id: `msg-${streamKey}` }),
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
            timeline: appendTimelineItem(base.timeline, { kind: "message", id: `msg-${streamKey}` }),
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

    case "TOGGLE_THINKING":
      return { ...state, thinkingCollapsed: !state.thinkingCollapsed };

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
