import crypto from "node:crypto";

import type { PlatformEventEnvelope, PlatformEventType } from "../contracts/events.js";
import type { PiAgentEvent } from "../pi-sdk/index.js";
import { sanitizeSensitiveText, sanitizeToolResult } from "./sanitize.js";

export class PlatformEventMapper {
  private sequence = 0;
  private turnId = "";
  private assistantError: string | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly streamId: string,
  ) {}

  /** 最近一条 assistant 消息的 stopReason="error" 原因（PI 模型失败不抛出，见 A4 CHAT-06） */
  get lastAssistantError(): string | undefined {
    return this.assistantError;
  }

  /** turn 终态信封（turn.failed/cancelled/interrupted 进会话 SSE，驱动 Desktop 终态投影） */
  terminal(
    type: "turn.failed" | "turn.cancelled" | "turn.interrupted",
    payload: Record<string, unknown>,
  ): PlatformEventEnvelope {
    return this.envelope(type, payload);
  }

  sessionStatus(status: "running" | "idle" | "error"): PlatformEventEnvelope {
    return this.envelope("session.status", { status });
  }

  error(message: string, code = "SESSION_ERROR", retryable = false): PlatformEventEnvelope {
    return this.envelope("error", { code, message, retryable });
  }

  map(event: PiAgentEvent): PlatformEventEnvelope[] {
    if (event.type === "agent_start" || event.type === "agent_end") return [];
    if (event.type === "turn_start") {
      this.turnId = `turn-${crypto.randomUUID()}`;
      this.assistantError = undefined;
      return [this.envelope("turn.started", { turnId: this.turnId })];
    }
    if (event.type === "turn_end") {
      const payload: Record<string, unknown> = { turnId: this.turnId };
      if (event.usage) payload.usage = event.usage;
      if (event.context) payload.context = event.context;
      return [this.envelope("turn.completed", payload)];
    }
    if (event.type === "compaction_start") {
      return [this.envelope("session.compacting", { reason: event.reason })];
    }
    if (event.type === "compaction_end") {
      const payload: Record<string, unknown> = {
        reason: event.reason,
        aborted: event.aborted,
      };
      if (event.tokensBefore !== undefined) payload.tokensBefore = event.tokensBefore;
      if (event.estimatedTokensAfter !== undefined) {
        payload.tokensAfter = event.estimatedTokensAfter;
      }
      if (event.summary !== undefined) {
        payload.summary = sanitizeSensitiveText(event.summary, 500);
      }
      if (event.errorMessage !== undefined) {
        payload.errorMessage = sanitizeSensitiveText(event.errorMessage, 200);
      }
      return [this.envelope("session.compacted", payload)];
    }
    if (event.type === "message_start") {
      return event.role === "assistant"
        ? [this.envelope("message.started", { role: event.role })]
        : [];
    }
    if (event.type === "text_delta") {
      return [this.envelope("message.delta", { role: "assistant", delta: event.delta })];
    }
    if (event.type === "thinking_delta") {
      return [this.envelope("thinking.delta", { delta: event.delta })];
    }
    if (event.type === "message_end") {
      if (event.role === "assistant") {
        if (event.stopReason === "error") {
          this.assistantError = sanitizeSensitiveText(event.errorMessage ?? "模型调用失败", 200);
        }
        return [
          this.envelope("message.completed", {
            role: event.role,
            content: event.content,
          }),
        ];
      }
      return [];
    }
    if (event.type === "tool_start") {
      return [
        this.envelope("tool.started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }),
      ];
    }
    if (event.type === "tool_delta") {
      const safeDelta = sanitizeSensitiveText(event.delta, 200);
      return [
        this.envelope("tool.delta", {
          toolCallId: event.toolCallId,
          delta: safeDelta,
        }),
      ];
    }
    if (event.type !== "tool_end") return [];
    const safeResult = sanitizeToolResult(event.result);
    return [
      this.envelope("tool.completed", {
        toolCallId: event.toolCallId,
        result: safeResult,
        isError: event.isError,
      }),
    ];
  }

  private envelope(type: PlatformEventType, payload: unknown): PlatformEventEnvelope {
    this.sequence += 1;
    return {
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: this.sessionId,
      streamId: this.streamId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      type,
      payload,
    } as PlatformEventEnvelope;
  }
}
