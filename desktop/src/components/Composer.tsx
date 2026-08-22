import { ChevronDown, Folder, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ModelOption, ModelRef } from "../data/source.js";
import "./composer.css";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const TOOL_MODES = [
  { id: "off", label: "off", description: "不调用工具" },
  { id: "read-only", label: "read-only", description: "只读" },
  { id: "all", label: "all", description: "可写入需确认工作区" },
] as const;
export type ToolMode = (typeof TOOL_MODES)[number]["id"];

type OpenMenu = "model" | "thinking" | "tool" | null;

interface ComposerProps {
  readonly agentName: string;
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly streaming: boolean;
  readonly autoFocus?: boolean;
  readonly models: readonly ModelOption[];
  readonly model: ModelRef | null;
  readonly onModel: (model: ModelRef) => void;
  readonly thinkingLevel: string;
  readonly onThinkingLevel: (level: string) => void;
  readonly toolMode: string;
  readonly onToolMode: (mode: string) => void;
  readonly workspace: string | null;
}

function matches(ref: ModelRef, option: ModelOption): boolean {
  return ref.providerId === option.providerId && ref.modelId === option.modelId;
}

function basename(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).at(-1) ?? cleaned;
}

export function Composer({
  agentName, draft, onDraft, onSend, onStop, streaming, autoFocus = false,
  models, model, onModel, thinkingLevel, onThinkingLevel, toolMode, onToolMode, workspace,
}: ComposerProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const availableModels = models.filter((option) => option.credentialConfigured);
  const noModels = availableModels.length === 0;
  const currentModel = model === null ? undefined : availableModels.find((option) => matches(model, option));

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  // streaming 时强制收拢浮层
  useEffect(() => {
    if (streaming) setOpenMenu(null);
  }, [streaming]);

  useEffect(() => {
    if (openMenu === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openMenu]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }

  function toggle(menu: Exclude<OpenMenu, null>) {
    setOpenMenu((prev) => (prev === menu ? null : menu));
  }

  const modelChipLabel = noModels ? "未配置模型" : (currentModel?.name ?? "选择模型");
  const canSend = draft.trim() !== "" && !streaming;

  return (
    <div className="composer">
      {openMenu !== null && <div className="composer-backdrop" onMouseDown={() => setOpenMenu(null)} />}
      <textarea
        ref={textareaRef}
        aria-label={`给 ${agentName} 的消息`}
        placeholder={`和${agentName}继续…`}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        autoFocus={autoFocus}
      />
      <div className="composer-bar">
        <div className="composer-group">
          {/* 附件/工具按钮随附件投影（wiring backlog ④）一并回归 */}
          <span className="chip" title={workspace ?? undefined}>
            <Folder size={12} />
            {workspace === null ? "未设置工作目录" : basename(workspace)}
          </span>
        </div>
        <div className="composer-group">
          <span className="composer-pop">
            <button
              type="button"
              className="chip chip-btn composer-chip"
              disabled={streaming}
              aria-haspopup="menu"
              aria-expanded={openMenu === "tool"}
              onClick={() => toggle("tool")}
            >
              {toolMode}<ChevronDown size={11} />
            </button>
            {openMenu === "tool" && (
              <div className="composer-menu" role="menu" aria-label="工具模式">
                {TOOL_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={toolMode === mode.id ? "is-active" : ""}
                    onClick={() => { onToolMode(mode.id); setOpenMenu(null); }}
                  >
                    <strong>{mode.label}</strong>
                    <small>{mode.description}</small>
                  </button>
                ))}
              </div>
            )}
          </span>

          <span className="composer-pop">
            <button
              type="button"
              className="chip chip-btn composer-chip"
              disabled={streaming}
              aria-haspopup="menu"
              aria-expanded={openMenu === "thinking"}
              onClick={() => toggle("thinking")}
            >
              {thinkingLevel}<ChevronDown size={11} />
            </button>
            {openMenu === "thinking" && (
              <div className="composer-menu" role="menu" aria-label="思考级别">
                {THINKING_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={thinkingLevel === level ? "is-active" : ""}
                    onClick={() => { onThinkingLevel(level); setOpenMenu(null); }}
                  >
                    <strong>{level}</strong>
                  </button>
                ))}
              </div>
            )}
          </span>

          <span className="composer-pop">
            <button
              type="button"
              className="chip chip-btn composer-chip"
              disabled={streaming || noModels}
              aria-haspopup="menu"
              aria-expanded={openMenu === "model"}
              onClick={() => toggle("model")}
            >
              {modelChipLabel}{noModels ? null : <ChevronDown size={11} />}
            </button>
            {openMenu === "model" && (
              <div className="composer-menu" role="menu" aria-label="模型">
                {availableModels.map((option) => {
                  const active = model !== null && matches(model, option);
                  return (
                    <button
                      key={`${option.providerId}:${option.modelId}`}
                      type="button"
                      className={active ? "is-active" : ""}
                      onClick={() => { onModel({ providerId: option.providerId, modelId: option.modelId }); setOpenMenu(null); }}
                    >
                      <strong>{option.name}</strong>
                      <small>{option.providerId}</small>
                    </button>
                  );
                })}
              </div>
            )}
          </span>

          <button
            type="button"
            className={`send-btn${streaming ? " is-stop" : ""}`}
            aria-label={streaming ? "停止生成" : "发送"}
            title={streaming ? "停止生成" : "发送"}
            disabled={!streaming && !canSend}
            onClick={streaming ? onStop : onSend}
          >
            {streaming ? <Square size={13} fill="currentColor" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
