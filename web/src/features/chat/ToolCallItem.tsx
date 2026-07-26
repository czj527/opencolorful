import type { ToolCall } from "./chat-state.js";
import { Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import styles from "./ToolCallItem.module.css";

interface ToolCallItemProps {
  readonly toolCall: ToolCall;
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const statusBorderClass: Record<ToolCall["status"], string | undefined> = {
  running: styles.toolCallRunning,
  completed: styles.toolCallCompleted,
  error: styles.toolCallError,
};

export function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const { toolName, status, result, delta } = toolCall;

  const cardClass = [
    styles.toolCall ?? "",
    statusBorderClass[status] ?? "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cardClass}
      data-testid={`tool-call-${toolCall.toolCallId}`}
    >
      <div className={styles.header ?? ""}>
        <Wrench size={12} aria-hidden="true" />
        <span className={styles.toolName ?? ""}>{toolName}</span>
        {status === "running" && <Loader2 size={12} className={`spinner-icon ${styles.spinnerIcon ?? ""}`} aria-label="运行中" />}
        {status === "completed" && <CheckCircle2 size={12} color="var(--success)" aria-label="已完成" />}
        {status === "error" && <XCircle size={12} color="var(--danger)" aria-label="失败" />}
        <span className={styles.statusText ?? ""}>
          {status === "running" ? "运行中" : status === "completed" ? "完成" : "失败"}
        </span>
      </div>
      {delta && status === "running" && (
        <div className={styles.delta ?? ""}>
          {delta.slice(-200)}
        </div>
      )}
      {status !== "running" && result !== undefined && (
        <div className={styles.result ?? ""}>
          {summarizeResult(result)}
        </div>
      )}
    </div>
  );
}
