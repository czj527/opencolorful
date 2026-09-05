import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { UtilityCompletion, UsageTokenTotals } from "../contracts/usage.js";
import type { PiResolvedModel } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// 工具型 LLM 调用的轻量适配器（波次 A8a：usage 账目透出）。
// 不挂载工具、不流式——仅发送单轮 prompt 并提取纯文本响应。
// 返回 UtilityCompletion：text 与本次调用的 token 账目分离；
// usage=null 表示运行时未提供账目（明确语义，不伪造 0）。
// stopReason 非法仍抛错，但把可得的 usage 挂到 UtilityTextCallError.usage；
// abort 路径异常原样上抛（isAbortLikeError 可识别为取消，不吞异常）。
// ═══════════════════════════════════════════════════════════════

/** completeUtilityText 失败（stopReason 非法 / 空响应）时抛出的错误：附带可得的 token 账目。 */
export class UtilityTextCallError extends Error {
  /** 失败消息上可得的账目；运行时完全未提供时为 null（不伪造 0）。 */
  readonly usage: UsageTokenTotals | null;

  constructor(message: string, usage: UsageTokenTotals | null) {
    super(message);
    this.name = "UtilityTextCallError";
    this.usage = usage;
  }
}

/** abort 语义识别：AbortSignal 已中止，或异常本身是 abort 类（保持既有"不吞异常"行为，仅做识别）。 */
export function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const code = (error as { code?: unknown }).code;
    if (code === "ABORT_ERR" || code === 20 /* DOMException.ABORT_ERR */) return true;
  }
  return false;
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * 从 PI AssistantMessage 提取 token 账目。stopReason=error/aborted 时消息可能
 * 仍带部分 usage——照常提取；运行时完全未提供账目时返回 null（不伪造 0）。
 */
function extractUsage(message: AssistantMessage): UsageTokenTotals | null {
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const raw = usage as Record<string, unknown>;
  return {
    input: toNonNegativeInteger(raw.input),
    output: toNonNegativeInteger(raw.output),
    cacheRead: toNonNegativeInteger(raw.cacheRead),
    cacheWrite: toNonNegativeInteger(raw.cacheWrite),
    totalTokens: toNonNegativeInteger(raw.totalTokens),
  };
}

export async function completeUtilityText(options: {
  runtime: ModelRuntime;
  model: Model<Api>;
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<UtilityCompletion> {
  const { runtime, model, systemPrompt, prompt, maxTokens, signal } = options;

  // abort 由运行时抛出：原样上抛（保持既有行为，不吞异常）；isAbortLikeError 供调用方识别取消。
  const message: AssistantMessage = await runtime.completeSimple(
    model,
    {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      messages: [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    },
    {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(signal !== undefined ? { signal } : {}),
    },
  );

  // PI 的 error/aborted 都以 assistant message 收尾（不抛出）：stopReason 非法即失败；
  // 消息上可得的 usage（可能为部分账目）挂到 Error.usage 供调用方记录 failed/cancelled 行。
  const usage = extractUsage(message);

  if (message.stopReason !== "stop" && message.stopReason !== "length") {
    throw new UtilityTextCallError(
      `LLM 调用失败: stopReason=${message.stopReason}${
        message.errorMessage ? ` message=${message.errorMessage}` : ""
      }`,
      usage,
    );
  }

  const texts = message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as { text: string }).text === "string",
    )
    .map((block) => block.text);

  if (texts.length === 0) {
    throw new UtilityTextCallError("LLM 返回了空响应（无可提取的文本块）", usage);
  }

  return { text: texts.join(""), usage };
}

/**
 * 基于平台契约的 opaque PiResolvedModel 直接调用（平台侧不暴露 PI 私有类型，
 * 由适配层在此完成 model/runtime 的类型收窄）。返回 UtilityCompletion（text + usage）。
 */
export async function completeUtilityTextForResolved(
  resolved: PiResolvedModel,
  options: {
    systemPrompt?: string;
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<UtilityCompletion> {
  return completeUtilityText({
    runtime: resolved.runtime as ModelRuntime,
    model: resolved.model as Model<Api>,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    prompt: options.prompt,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}
