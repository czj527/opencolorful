import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { PiResolvedModel } from "./types.js";

/**
 * 工具型 LLM 调用的轻量适配器。
 * 不挂载工具、不流式——仅发送单轮 prompt 并提取纯文本响应。
 *
 * 用于 rolling summary、格式修复等非对话场景。
 */
export async function completeUtilityText(options: {
  runtime: ModelRuntime;
  model: Model<Api>;
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { runtime, model, systemPrompt, prompt, maxTokens, signal } = options;

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

  if (
    message.stopReason !== "stop" &&
    message.stopReason !== "length"
  ) {
    throw new Error(
      `LLM 调用失败: stopReason=${message.stopReason}${
        message.errorMessage ? ` message=${message.errorMessage}` : ""
      }`,
    );
  }

  const texts = message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as { text: string }).text === "string",
    )
    .map((block) => block.text);

  if (texts.length === 0) {
    throw new Error("LLM 返回了空响应（无可提取的文本块）");
  }

  return texts.join("");
}

/**
 * 基于平台契约的 opaque PiResolvedModel 直接调用（平台侧不暴露 PI 私有类型，
 * 由适配层在此完成 model/runtime 的类型收窄）。
 */
export async function completeUtilityTextForResolved(
  resolved: PiResolvedModel,
  options: {
    systemPrompt?: string;
    prompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  return completeUtilityText({
    runtime: resolved.runtime as ModelRuntime,
    model: resolved.model as Model<Api>,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    prompt: options.prompt,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}
