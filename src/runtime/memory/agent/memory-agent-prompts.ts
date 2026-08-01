import Value from "typebox/value";
import { ToolArgSchemas, type MemoryToolName } from "./memory-agent-tools.js";
export const MEMORY_AGENT_SYSTEM_PROMPT = `你是平台内部记忆整理者。只提出案，不直接写库。必须引用证据，优先用户明确意图；跨会话且跨日期确认才算独立强度信号；冲突必须标记并保留旧事实。不得输出或索取密钥、网络、shell或完整敏感原文。每次只输出一个 JSON：{"kind":"tool_call","tool":"...","args":{...}} 或 {"kind":"final","report":{"summary":"...","issues":[]}}。`;
export function buildMemoryAgentPrompt(input: { batches: readonly unknown[]; journalIntents: readonly unknown[]; history: readonly string[]; budget: string; weekly?: boolean }): string {
  const weeklyNote = input.weekly === true
    ? "\n本周复核模式：重点复核中期→永久候选、低置信度事实与跨日期聚合信号；未达多来源/高可信度标准不得提议晋升永久。"
    : "";
  return `当前待整理批次：${JSON.stringify(input.batches)}\n待处理记忆意图：${JSON.stringify(input.journalIntents)}\n工具结果历史：${input.history.join("\n")}\n预算提示：${input.budget}${weeklyNote}\n请继续整理。`;
}
export type AgentReply = { kind: "tool_call"; tool: MemoryToolName; args: unknown } | { kind: "final"; report: unknown } | { kind: "malformed" };
function firstJson(text: string): unknown { const start = text.search(/[({[]/); if (start < 0) return undefined; const open = text[start]; const close = open === "{" ? "}" : open === "[" ? "]" : ")"; let depth = 0; let quote = false; let escaped = false; for (let i = start; i < text.length; i += 1) { const c = text[i]; if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quote = false; continue; } if (c === '"') quote = true; else if (c === open) depth += 1; else if (c === close && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; } } } return undefined; }
export function parseAgentReply(text: string): AgentReply { const raw = firstJson(text.replace(/```(?:json)?/gi, "")); if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "malformed" }; const obj = raw as Record<string, unknown>; if (obj["kind"] === "tool_call" && typeof obj["tool"] === "string" && obj["tool"] in ToolArgSchemas) { const tool = obj["tool"] as MemoryToolName; if (Value.Check(ToolArgSchemas[tool], obj["args"])) return { kind: "tool_call", tool, args: obj["args"] }; } if (obj["kind"] === "final") return { kind: "final", report: obj["report"] }; return { kind: "malformed" }; }
