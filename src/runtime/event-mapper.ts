import crypto from "node:crypto";

import type { PlatformEventEnvelope, PlatformEventType } from "../contracts/events.js";
import type { PiAgentEvent } from "../pi-sdk/index.js";

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

  error(message: string): PlatformEventEnvelope {
    return this.envelope("error", {
      code: "SESSION_ERROR",
      message,
      retryable: false,
    });
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
      return [
        this.envelope("tool.delta", {
          toolCallId: event.toolCallId,
          delta: event.delta,
        }),
      ];
    }
    if (event.type !== "tool_end") return [];
    return [
      this.envelope("tool.completed", {
        toolCallId: event.toolCallId,
        result: event.result,
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
