import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import type { ContextUsage, ModelSummary, TokenUsage } from "../../lib/types.js";
import { ContextUsageRing } from "./ContextUsageRing.jsx";
import { extractCommandQuery, filterCommands, parseCommandName, type CommandName } from "./commands.js";
import "./chat.css";

interface MessageComposerProps {
  readonly disabled: boolean;
  readonly running: boolean;
  readonly onSend: (content: string) => void;
  readonly onAbort: () => void;
  /** 会话命令执行回调（可选，缺省时命令面板不可用）；执行后输入框由组件自行清空 */
  readonly onExecuteCommand?: (name: CommandName) => void;
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
  /** 用量：上下文占用 + 会话累计（可选，缺省不渲染圆环） */
  readonly contextUsage?: ContextUsage | null;
  readonly usageTotals?: TokenUsage;
  readonly cacheHitRate?: number | null;
}

const TOOL_MODES: { value: string; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "read-only", label: "只读" },
  { value: "all", label: "全部" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export function MessageComposer({
  disabled,
  running,
  onSend,
  onAbort,
  onExecuteCommand,
  models,
  selectedModel,
  onSelectModel,
  toolMode,
  onToolModeChange,
  thinkingLevel,
  onThinkingLevelChange,
  contextUsage,
  usageTotals,
  cacheHitRate,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const commandQuery = onExecuteCommand !== undefined ? extractCommandQuery(value) : null;
  const filteredCommands = commandQuery !== null ? filterCommands(commandQuery) : [];
  const showPanel = panelOpen && commandQuery !== null && filteredCommands.length > 0;

  // 输入变化时同步面板开关与高亮
  useEffect(() => {
    if (commandQuery !== null) {
      setPanelOpen(true);
      setHighlightIndex(0);
    } else {
      setPanelOpen(false);
    }
  }, [commandQuery]);

  // 点击外部关闭面板
  useEffect(() => {
    if (!showPanel) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setPanelOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showPanel]);

  const executeCommand = (name: CommandName) => {
    if (onExecuteCommand === undefined) return;
    setPanelOpen(false);
    onExecuteCommand(name);
    // 命令消息不发送给 LLM；执行后清空输入框（/clear 语义相同）
    setValue("");
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || running) return;
    // 首字符为 / 时按命令处理，不发送给 LLM
    const commandName = parseCommandName(trimmed);
    if (commandName !== null && onExecuteCommand !== undefined) {
      executeCommand(commandName);
      return;
    }
    onSend(trimmed);
    setValue("");
  };

  const modelValue = selectedModel
    ? `${selectedModel.providerId}:${selectedModel.modelId}`
    : "";

  return (
    <div className="chat-composer-card" ref={containerRef}>
      {/* 输入区：textarea + 命令面板 */}
      <div className="chat-composer-input-area">
        {showPanel && (
          <div className="command-panel" role="listbox" aria-label="会话命令" data-testid="command-panel">
            {filteredCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === highlightIndex}
                className={`command-panel-item${index === highlightIndex ? " active" : ""}`}
                data-testid={`command-item-${command.name}`}
                onMouseEnter={() => setHighlightIndex(index)}
                onClick={() => executeCommand(command.name)}
              >
                <span className="command-panel-name">{command.usage}</span>
                <span className="command-panel-desc">{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          className="chat-input"
          placeholder={disabled ? "请先选择会话" : "输入消息，Enter 发送，Shift+Enter 换行，/ 打开命令"}
          aria-label="消息输入"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (showPanel) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIndex((index) => (index + 1) % filteredCommands.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const command = filteredCommands[highlightIndex];
                if (command !== undefined) executeCommand(command.name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPanelOpen(false);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>

      {/* 控件行：工具模式 | 思考级别 | 模型选择 | 发送 */}
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
            <option key={l} value={l}>🧠 {THINKING_LABELS[l]}</option>
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

        {usageTotals !== undefined && (
          <ContextUsageRing
            context={contextUsage ?? null}
            totals={usageTotals}
            cacheHitRate={cacheHitRate ?? null}
          />
        )}

        {running ? (
          <button
            className="icon-button danger composer-send-btn"
            onClick={onAbort}
            type="button"
            aria-label="中断生成"
            title="中断当前生成"
          >
            <Square size={14} aria-hidden="true" />
          </button>
        ) : (
          <button
            className="icon-button primary composer-send-btn"
            onClick={submit}
            disabled={disabled || !value.trim()}
            type="button"
            aria-label="发送消息"
            title="发送消息"
          >
            <Send size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
