import { AlertTriangle, Paperclip } from "lucide-react";
import type { Attachment } from "./chat-state.js";
import { isSafeUrl } from "./chat-state.js";

interface UiProjectionProps {
  readonly attachments: readonly Attachment[];
}

/**
 * UI 投影占位：A2UI/TokUI payload 的安全展示。
 * 未知或非法 payload 显示安全错误占位，绝不执行任意脚本或 raw HTML。
 */
export function UiProjection({ attachments }: UiProjectionProps) {
  if (attachments.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="ui-projection">
      {attachments.map((attachment) => (
        <div
          key={attachment.attachmentId}
          style={{
            padding: "6px 10px",
            background: "var(--bg-tertiary)",
            borderRadius: 6,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Paperclip size={12} aria-hidden="true" />
          <span>{attachment.name}</span>
          {attachment.mimeType && (
            <span style={{ color: "var(--text-secondary)" }}>({attachment.mimeType})</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface UnsafePayloadNoticeProps {
  readonly reason: string;
}

export function UnsafePayloadNotice({ reason }: UnsafePayloadNoticeProps) {
  return (
    <div
      style={{
        padding: "6px 10px",
        background: "var(--bg-tertiary)",
        borderRadius: 6,
        borderLeft: "2px solid var(--danger)",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
      role="alert"
    >
      <AlertTriangle size={12} color="var(--danger)" aria-hidden="true" />
      <span>已阻止不安全的 UI 内容：{reason}</span>
    </div>
  );
}

export { isSafeUrl };
