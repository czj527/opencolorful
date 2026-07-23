import { useState } from "react";
import { Send, Square, Package } from "lucide-react";

interface MessageComposerProps {
  readonly disabled: boolean;
  readonly running: boolean;
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onCompact: () => void;
}

export function MessageComposer({ disabled, running, onSend, onAbort, onCompact }: MessageComposerProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || running) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <div className="chat-input-area">
      <textarea
        className="chat-input"
        placeholder={disabled ? "请先选择会话" : "输入消息，Enter 发送，Shift+Enter 换行"}
        aria-label="消息输入"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {running ? (
        <button
          className="icon-button danger"
          onClick={onAbort}
          type="button"
          aria-label="中断生成"
          title="中断当前生成"
        >
          <Square size={14} aria-hidden="true" />
        </button>
      ) : (
        <button
          className="icon-button primary"
          onClick={submit}
          disabled={disabled || !value.trim()}
          type="button"
          aria-label="发送消息"
          title="发送消息"
        >
          <Send size={14} aria-hidden="true" />
        </button>
      )}
      <button
        className="icon-button"
        onClick={onCompact}
        disabled={disabled || running}
        type="button"
        aria-label="压缩上下文"
        title="压缩会话上下文"
      >
        <Package size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
