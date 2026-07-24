import { Settings, Wrench, Brain, Send, Square } from "lucide-react";
import type { ModelSummary } from "../../lib/types.js";

export interface InputControlBarProps {
  readonly models: readonly ModelSummary[];
  readonly selectedModel: { providerId: string; modelId: string } | null;
  readonly toolMode: string;
  readonly thinkingLevel: string;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly onToolModeChange: (mode: string) => void;
  readonly onThinkingLevelChange: (level: string) => void;
  readonly onSend: () => void;
  readonly onAbort: () => void;
  readonly onSettingsClick?: (() => void) | undefined;
}

const TOOL_MODES: { value: string; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "read-only", label: "只读" },
  { value: "all", label: "全部" },
];

const THINKING_LEVELS: string[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

export function InputControlBar(props: InputControlBarProps) {
  const modelValue = props.selectedModel
    ? `${props.selectedModel.providerId}:${props.selectedModel.modelId}`
    : "";

  return (
    <div className="chat-control-bar">
      {/* 左侧：工具模式 + 思考级别 */}
      <div className="control-group">
        <select
          className="control-select"
          value={props.toolMode}
          onChange={(e) => props.onToolModeChange(e.target.value)}
          disabled={props.disabled}
          aria-label="工具模式"
        >
          {TOOL_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              🔧 {m.label}
            </option>
          ))}
        </select>

        <select
          className="control-select"
          value={props.thinkingLevel}
          onChange={(e) => props.onThinkingLevelChange(e.target.value)}
          disabled={props.disabled}
          aria-label="思考级别"
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              🧠 {l}
            </option>
          ))}
        </select>
      </div>

      {/* 中间：模型选择 */}
      <select
        className="control-select model-select"
        value={modelValue}
        onChange={(e) => {
          const [providerId, modelId] = e.target.value.split(":");
          if (providerId && modelId) props.onSelectModel(providerId, modelId);
        }}
        disabled={props.disabled}
        aria-label="选择模型"
      >
        <option value="">未选择模型</option>
        {props.models.map((m) => (
          <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>
            {m.name}
          </option>
        ))}
      </select>

      {/* 右侧：设置 + 发送/中断 */}
      <div className="control-group control-right">
        {props.onSettingsClick && (
          <button
            type="button"
            className="control-btn"
            onClick={props.onSettingsClick}
            title="设置中心"
            aria-label="设置中心"
          >
            <Settings size={15} />
          </button>
        )}

        {props.running ? (
          <button
            type="button"
            className="control-btn danger"
            onClick={props.onAbort}
            aria-label="中断生成"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="control-btn primary"
            onClick={props.onSend}
            disabled={props.disabled}
            aria-label="发送消息"
          >
            <Send size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
