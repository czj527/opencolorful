import type { LiveEnvelope } from "../../../src/data/projector.js";

/**
 * SSE 固定事件回放序列（desktop-test-conventions.md §四.4）。
 *
 * 形状对齐平台事件 Envelope（protocolVersion=1，streamId 内 sequence 严格递增），
 * 内容为脱敏后的示意样本——不含任何真实会话数据。由 replay-chat-source 在
 * sendPrompt 时按序回放，保证断言确定性（生产 mock-source 的时间片脚本不进入测试）。
 */

const STREAM_ID = "st-fixture-replay-1";
const BASE_TIME = "2026-08-20T10:00:00+08:00";

let sequenceCounter = 0;
function envelope(type: string, payload: unknown): LiveEnvelope {
  sequenceCounter += 1;
  return {
    eventId: `ev-fixture-replay-${sequenceCounter}`,
    streamId: STREAM_ID,
    sequence: sequenceCounter,
    timestamp: BASE_TIME,
    type,
    payload,
  };
}

/** 回放用户消息（同时是 sendPrompt 的入参） */
export const replayUserMessage = "帮我核对回放序列的投影";

/** 回放助手定稿文本（message.completed 的正文） */
export const replayAssistantText = "回放序列校验完成：思考与消息均已投影。";

/** 思考事件行在时间线上的定稿摘要（projector 在 turn.completed 后把「正在思考…」收敛为「思考完成」） */
export const replayThinkingSummary = "思考完成";

export const replaySequence: readonly LiveEnvelope[] = [
  envelope("turn.started", { turnId: "turn-fixture-replay-1" }),
  envelope("thinking.delta", { delta: `回放投影自检：先确认 streamId 与 sequence 连续性。` }),
  envelope("message.started", { role: "assistant" }),
  envelope("message.delta", { role: "assistant", delta: "回放序列校验完成：" }),
  envelope("message.delta", { role: "assistant", delta: "思考与消息均已投影。" }),
  envelope("message.completed", { role: "assistant", content: replayAssistantText }),
  envelope("turn.completed", {
    turnId: "turn-fixture-replay-1",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  }),
];
