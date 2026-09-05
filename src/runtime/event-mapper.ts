import crypto from "node:crypto";

import type { PlatformEventEnvelope, PlatformEventType, ContextUsage, TokenUsage } from "../contracts/events.js";
import type { PiAgentEvent } from "../pi-sdk/index.js";
import { sanitizeSensitiveText, sanitizeToolResult } from "./sanitize.js";

export class PlatformEventMapper {
  private sequence = 0;
  private turnId = "";
  private assistantError: string | undefined;
  private assistantAborted = false;
  private terminalTypeValue:
    | "turn.completed"
    | "turn.failed"
    | "turn.cancelled"
    | "turn.interrupted"
    | undefined;
  // A8a：失败/取消 turn 的账目透传。PI 的 error/aborted turn 也以 turn_end 收尾
  // （带累计 usage/context），但该 turn 不能投影 turn.completed；这里先把账目
  // 暂存，供 runtime 终态化时附到 turn.failed/turn.cancelled payload 供用量摄取。
  private pendingTurnUsage: TokenUsage | undefined;
  private pendingTurnContext: ContextUsage | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly streamId: string,
  ) {}

  /** 最近一条 assistant 消息的 stopReason="error" 原因（PI 模型失败不抛出，见 A4 CHAT-06） */
  get lastAssistantError(): string | undefined {
    return this.assistantError;
  }

  /** 当前 PI turn 已接受的唯一终态；未终态化时为 undefined。 */
  get terminalType():
    | "turn.completed"
    | "turn.failed"
    | "turn.cancelled"
    | "turn.interrupted"
    | undefined {
    return this.terminalTypeValue;
  }

  /** 最近一条 assistant 消息是否以 PI stopReason="aborted" 收尾。 */
  get isAssistantAborted(): boolean {
    return this.assistantAborted;
  }

  /** turn 终态信封（turn.failed/cancelled/interrupted 进会话 SSE，驱动 Desktop 终态投影） */
  terminal(
    type: "turn.failed" | "turn.cancelled" | "turn.interrupted",
    payload: Record<string, unknown>,
  ): PlatformEventEnvelope | undefined {
    if (this.terminalTypeValue !== undefined) return undefined;
    this.terminalTypeValue = type;
    // A8a：终态 payload 附带 turnId + 可得账目（usage 缺省 = 无账目，供 UsageRecorder 落 0 行）。
    const enriched: Record<string, unknown> = { ...payload };
    if (this.turnId !== "") {
      enriched.turnId = this.turnId;
    }
    if (this.pendingTurnUsage !== undefined) {
      enriched.usage = this.pendingTurnUsage;
    }
    return this.envelope(type, enriched);
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
      this.assistantAborted = false;
      this.terminalTypeValue = undefined;
      this.pendingTurnUsage = undefined;
      this.pendingTurnContext = undefined;
      return [this.envelope("turn.started", { turnId: this.turnId })];
    }
    if (event.type === "turn_end") {
      // A8a：先暂存本 turn 账目（error/aborted turn 也带 turn_end，供终态化透传），
      // 再判定该 turn 能否投影 turn.completed。
      if (event.usage) this.pendingTurnUsage = event.usage;
      if (event.context) this.pendingTurnContext = event.context;
      // PI 的 error/aborted 都以 assistant message + 正常 resolved prompt 收尾。
      // 这两类 turn 不能先投影 completed；Runtime 会在 prompt 收尾时提交对应
      // failed/cancelled 终态，避免 usage/memory 下游收到相互冲突的终态。
      if (
        this.assistantError !== undefined ||
        this.assistantAborted ||
        this.terminalTypeValue !== undefined
      ) {
        return [];
      }
      const payload: Record<string, unknown> = { turnId: this.turnId };
      if (event.usage) payload.usage = event.usage;
      if (event.context) payload.context = event.context;
      this.terminalTypeValue = "turn.completed";
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
        } else if (event.stopReason === "aborted") {
          this.assistantAborted = true;
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
