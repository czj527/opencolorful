// ═══════════════════════════════════════════════════════════════
// Rolling summary LLM prompt 构建
// ═══════════════════════════════════════════════════════════════

import type { PiMessageText } from "./jsonl-branch-reader.js";

function formatMessagesForPrompt(messages: readonly PiMessageText[]): string {
  return messages
    .map((msg) => {
      const roleLabel = msg.role === "user" ? "用户" : "助手";
      const toolLine =
        msg.toolCalls.length > 0
          ? `\n[工具调用: ${msg.toolCalls.join(", ")}]`
          : "";
      return `**${roleLabel}**: ${msg.text}${toolLine}`;
    })
    .join("\n\n---\n\n");
}

const SYSTEM_PROMPT = `你是一个会话摘要助手。你的任务是用中文撰写结构化的滚动摘要。

必须严格包含以下两个节（使用 ### 三级标题）：

### 重要事实
- 用简洁的项目符号列出对话中提及的关键事实、决定、偏好、约束等。
- 如果提供了之前的摘要，请保留仍有效的事实并整合新信息。

### 时间线
- 按时间顺序列出对话的关键节点，每条以 HH:mm 开头。
- 示例：- 14:03 用户询问了 XXX；助手建议 YYY
- 保持每条简洁，最多 1-2 行。

格式要求：
- 只输出上述两个节，不要输出额外内容。
- 使用 ### 三级标题，不要使用 # 或 ##。
- 每个项目符号以 - 开头。`;

export interface BuildRollingSummaryPromptInput {
  /** 上一版 rolling summary，首次摘要时为 undefined */
  previousSummary?: string;
  /** 需要处理的新消息 */
  newMessages: readonly PiMessageText[];
}

export function buildRollingSummaryPrompt(
  input: BuildRollingSummaryPromptInput,
): { systemPrompt: string; prompt: string } {
  const messagesBlock = formatMessagesForPrompt(input.newMessages);

  let prompt: string;
  if (input.previousSummary !== undefined) {
    prompt = `以下是之前的会话摘要：

${input.previousSummary}

以下是新的对话消息，请基于上述摘要和这些新消息更新滚动摘要：

${messagesBlock}`;
  } else {
    prompt = `以下是对话的全部消息，请生成首次滚动摘要：

${messagesBlock}`;
  }

  return { systemPrompt: SYSTEM_PROMPT, prompt };
}

export interface BuildRepairPromptInput {
  /** LLM 上一次输出的不规范格式 */
  previousOutput: string;
  /** 缺失的节 */
  missing: string[];
}

export function buildRepairPrompt(
  input: BuildRepairPromptInput,
): { systemPrompt: string; prompt: string } {
  const missingList = input.missing.map((s) => `- ${s}`).join("\n");
  return {
    systemPrompt: SYSTEM_PROMPT,
    prompt: `你上一次的输出缺少了以下必须的节：

${missingList}

请修复以下输出，确保包含所有必须的节（### 重要事实 和 ### 时间线），不要改动已有的内容：

${input.previousOutput}`,
  };
}
