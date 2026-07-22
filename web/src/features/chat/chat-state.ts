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

export interface ChatState {
  readonly messages: ChatMessage[];
  readonly toolCalls: Map<string, ToolCall>;
  readonly planItems: PlanItem[];
  readonly attachments: Attachment[];
  readonly currentStreamId: string | null;
  readonly lastSequence: number;
  readonly thinking: string;
  readonly thinkingCollapsed: boolean;
  readonly status: "idle" | "running" | "error";
  readonly error: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  toolCalls: new Map(),
  planItems: [],
  attachments: [],
  currentStreamId: null,
  lastSequence: 0,
  thinking: "",
  thinkingCollapsed: true,
  status: "idle",
  error: null,
};

// --- Actions ---

export type ChatAction =
  | { type: "RESET" }
  | { type: "PROMPT_SENT"; streamId: string }
  | { type: "EVENT"; event: PlatformEventEnvelope }
  | { type: "TOGGLE_THINKING" }
  | { type: "SET_ERROR"; error: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "RESET":
      return { ...initialChatState };

    case "PROMPT_SENT":
      return {
        ...state,
        currentStreamId: action.streamId,
        lastSequence: 0,
        status: "running",
        error: null,
        thinking: "",
        toolCalls: new Map(),
        planItems: [],
        attachments: [],
      };

    case "EVENT": {
      const event = action.event;

      // Skip duplicate or out-of-order events
      if (event.sequence <= state.lastSequence) return state;

      const base = { ...state, lastSequence: event.sequence };

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
          };

        case "message.delta": {
          const payload = event.payload as { role: string; delta: string };
          if (payload.role !== "assistant") return base;
          const lastMessage = base.messages[base.messages.length - 1];
          if (!lastMessage || !lastMessage.streaming) return base;
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
          return { ...base, thinking: base.thinking + payload.delta };
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
          return { ...base, toolCalls: newToolCalls };
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
      return { ...state, status: "error", error: action.error };
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
