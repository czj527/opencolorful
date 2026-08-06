import type { ToolCall } from "./chat-state.js";
import { Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { SkillInstallToolCard, isSkillInstallCardResult } from "../skills/SkillInstallToolCard.js";
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

  // Phase 13 T8：install_skill 工具调用 → 会话内安装状态卡
  // （风险确认用可追踪的一次性审批卡，不用普通弹窗承载完整安装流程）
  if (toolName === "install_skill" && (isSkillInstallCardResult(result) || status === "running")) {
    return (
      <SkillInstallToolCard
        toolName={toolName}
        status={status}
        result={result}
        {...(delta !== undefined ? { delta } : {})}
      />
    );
  }

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
