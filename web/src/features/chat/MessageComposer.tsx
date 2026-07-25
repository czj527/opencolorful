import { useState } from "react";
import { Send, Square, Package } from "lucide-react";
import type { ModelSummary } from "../../lib/types.js";
import "./chat.css";

interface MessageComposerProps {
  readonly disabled: boolean;
  readonly running: boolean;
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  readonly onCompact: () => void;
  /** 控件：模型选择 */
  readonly models: readonly ModelSummary[];
  readonly selectedModel: { providerId: string; modelId: string } | null;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  /** 控件：工具模式 */
  readonly toolMode: string;
  readonly onToolModeChange: (mode: string) => void;
  /** 控件：思考级别 */
  readonly thinkingLevel: string;
  readonly onThinkingLevelChange: (level: string) => void;
}

const TOOL_MODES: { value: string; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "read-only", label: "只读" },
  { value: "all", label: "全部" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function MessageComposer({
  disabled,
  running,
  onSend,
  onAbort,
  onCompact,
  models,
  selectedModel,
  onSelectModel,
  toolMode,
  onToolModeChange,
  thinkingLevel,
  onThinkingLevelChange,
}: MessageComposerProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || running) return;
    onSend(trimmed);
    setValue("");
  };

  const modelValue = selectedModel
    ? `${selectedModel.providerId}:${selectedModel.modelId}`
    : "";

  return (
    <div className="chat-composer-card">
      {/* 输入行 */}
      <div className="chat-composer-input-row">
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

      {/* 控件底行 */}
      <div className="chat-composer-controls">
        <select
          className="composer-control-select"
          value={toolMode}
          onChange={(e) => onToolModeChange(e.target.value)}
          disabled={disabled}
          aria-label="工具模式"
        >
          {TOOL_MODES.map((m) => (
            <option key={m.value} value={m.value}>🔧 {m.label}</option>
          ))}
        </select>

        <div className="composer-separator" />

        <select
          className="composer-control-select"
          value={thinkingLevel}
          onChange={(e) => onThinkingLevelChange(e.target.value)}
          disabled={disabled}
          aria-label="思考级别"
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>🧠 {l}</option>
          ))}
        </select>

        <div className="composer-separator" />

        <select
          className="composer-control-select composer-model-select"
          value={modelValue}
          onChange={(e) => {
            const [providerId, modelId] = e.target.value.split(":");
            if (providerId && modelId) onSelectModel(providerId, modelId);
          }}
          disabled={disabled}
          aria-label="选择模型"
        >
          <option value="">未选择模型</option>
          {models.map((m) => (
            <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>{m.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
