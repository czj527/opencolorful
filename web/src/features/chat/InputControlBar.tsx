import { Settings } from "lucide-react";
import type { ModelSummary } from "../../lib/types.js";

export interface InputControlBarProps {
  readonly models: readonly ModelSummary[];
  readonly selectedModel: { providerId: string; modelId: string } | null;
  readonly toolMode: string;
  readonly thinkingLevel: string;
  readonly disabled: boolean;
  readonly onSelectModel: (providerId: string, modelId: string) => void;
  readonly onToolModeChange: (mode: string) => void;
  readonly onThinkingLevelChange: (level: string) => void;
  readonly onSettingsClick?: (() => void) | undefined;
}

const TOOL_MODES: { value: string; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "read-only", label: "只读" },
  { value: "all", label: "全部" },
];

export function InputControlBar(props: InputControlBarProps) {
  const modelValue = props.selectedModel
    ? `${props.selectedModel.providerId}:${props.selectedModel.modelId}`
    : "";

  return (
    <div className="chat-control-bar">
      <select
        className="control-select"
        value={props.toolMode}
        onChange={(e) => props.onToolModeChange(e.target.value)}
        disabled={props.disabled}
        aria-label="工具模式"
      >
        {TOOL_MODES.map((m) => (
          <option key={m.value} value={m.value}>🔧 {m.label}</option>
        ))}
      </select>

      <select
        className="control-select"
        value={props.thinkingLevel}
        onChange={(e) => props.onThinkingLevelChange(e.target.value)}
        disabled={props.disabled}
        aria-label="思考级别"
      >
        {(["off","minimal","low","medium","high","xhigh","max"] as const).map((l) => (
          <option key={l} value={l}>🧠 {l}</option>
        ))}
      </select>

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
          <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>{m.name}</option>
        ))}
      </select>

      {props.onSettingsClick && (
        <button type="button" className="control-btn" onClick={props.onSettingsClick} title="设置中心" aria-label="设置中心">
          <Settings size={15} />
        </button>
      )}
    </div>
  );
}
