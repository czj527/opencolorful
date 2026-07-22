import crypto from "node:crypto";

import type { PlatformEventEnvelope, PlatformEventType } from "../contracts/events.js";
import type { PiAgentEvent } from "../pi-sdk/index.js";

const MAX_TOOL_RESULT_LENGTH = 2_000;

function sanitizeToolResult(result: unknown, _isError: boolean): unknown {
  if (result === undefined || result === null) return result;
  if (typeof result === "string") {
    return result.slice(0, MAX_TOOL_RESULT_LENGTH);
  }
  if (typeof result === "object") {
    try {
      const json = JSON.stringify(result);
      return JSON.parse(json.slice(0, MAX_TOOL_RESULT_LENGTH));
    } catch {
      return "[非 JSON 结果]";
    }
  }
  return result;
}

export class PlatformEventMapper {
  private sequence = 0;
  private turnId = "";

  constructor(
    private readonly sessionId: string,
    private readonly streamId: string,
  ) {}

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
      return [this.envelope("turn.started", { turnId: this.turnId })];
    }
    if (event.type === "turn_end") {
      return [this.envelope("turn.completed", { turnId: this.turnId })];
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
      return event.role === "assistant"
        ? [
            this.envelope("message.completed", {
              role: event.role,
              content: event.content,
            }),
          ]
        : [];
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
      const safeDelta = typeof event.delta === "string"
        ? event.delta.slice(0, 200)
        : event.delta;
      return [
        this.envelope("tool.delta", {
          toolCallId: event.toolCallId,
          delta: safeDelta,
        }),
      ];
    }
    if (event.type !== "tool_end") return [];
    const safeResult = sanitizeToolResult(event.result, event.isError);
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
