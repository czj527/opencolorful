import type { ToolCall } from "./chat-state.js";
import { Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface ToolCallItemProps {
  readonly toolCall: ToolCall;
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const { toolName, status, result, delta } = toolCall;

  return (
    <div
      style={{
        padding: "6px 10px",
        background: "var(--bg-tertiary)",
        borderRadius: 6,
        borderLeft: `2px solid ${status === "error" ? "var(--danger)" : status === "completed" ? "var(--success)" : "var(--warning)"}`,
        fontSize: 12,
        fontFamily: "monospace",
      }}
      data-testid={`tool-call-${toolCall.toolCallId}`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <Wrench size={12} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>{toolName}</span>
        {status === "running" && <Loader2 size={12} className="spinner-icon" aria-label="运行中" />}
        {status === "completed" && <CheckCircle2 size={12} color="var(--success)" aria-label="已完成" />}
        {status === "error" && <XCircle size={12} color="var(--danger)" aria-label="失败" />}
        <span style={{ color: "var(--text-secondary)" }}>
          {status === "running" ? "运行中" : status === "completed" ? "完成" : "失败"}
        </span>
      </div>
      {delta && status === "running" && (
        <div style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {delta.slice(-200)}
        </div>
      )}
      {status !== "running" && result !== undefined && (
        <div style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {summarizeResult(result)}
        </div>
      )}
    </div>
  );
}
