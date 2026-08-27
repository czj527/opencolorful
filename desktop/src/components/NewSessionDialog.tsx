import { FolderOpen, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Agent, Thread } from "../mock-data.js";
import { pickDirectory } from "../data/pick-directory.js";
import type { DesktopDataSource, ModelOption, ModelRef } from "../data/source.js";
import { toUserError } from "../errors.js";
import { THINKING_LEVELS, TOOL_MODES } from "./Composer.js";
import "./NewSessionDialog.css";

interface NewSessionDialogProps {
  readonly source: DesktopDataSource;
  readonly agents: readonly Agent[];
  readonly agentId: string;
  readonly models: readonly ModelOption[];
  readonly draftToolMode: string;
  readonly draftThinking: string;
  readonly draftModel: ModelRef | null;
  readonly onCreated: (thread: Thread, selectedAgentId: string) => void;
  readonly onClose: () => void;
}

function matchesModel(ref: ModelRef, option: ModelOption): boolean {
  return ref.providerId === option.providerId && ref.modelId === option.modelId;
}

function modelKey(ref: ModelRef): string {
  return `${ref.providerId}:${ref.modelId}`;
}

function parseModelKey(key: string): ModelRef | null {
  const index = key.indexOf(":");
  if (index <= 0 || index === key.length - 1) return null;
  return { providerId: key.slice(0, index), modelId: key.slice(index + 1) };
}

/**
 * T3：桌面端高级新建会话表单。
 *
 * 与侧栏 "+" 的快速草稿路径保持独立：本表单在落库前就明确
 * 标题、Agent、工作目录、工具模式、思考级别与模型，适合需要
 * 精细控制运行上下文的场景。
 */
export function NewSessionDialog({
  source,
  agents,
  agentId,
  models,
  draftToolMode,
  draftThinking,
  draftModel,
  onCreated,
  onClose,
}: NewSessionDialogProps) {
  const [selectedAgentId, setSelectedAgentId] = useState(agentId);
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [toolMode, setToolMode] = useState(draftToolMode);
  const [thinkingLevel, setThinkingLevel] = useState(draftThinking);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(draftModel);
  const [workspaceConfirmed, setWorkspaceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableModels = useMemo(() => models.filter((option) => option.credentialConfigured), [models]);

  // 切 Agent 时继承其 defaultCwd（与 web new-session 行为一致）
  useEffect(() => {
    const agent = agents.find((a) => a.id === selectedAgentId);
    if (agent?.workspace !== undefined) setCwd(agent.workspace);
  }, [selectedAgentId, agents]);

  // 模型默认：当前草稿优先，否则首个已配置凭据的模型
  useEffect(() => {
    if (availableModels.length === 0) {
      setSelectedModel(null);
      return;
    }
    setSelectedModel((current) => {
      if (current !== null && availableModels.some((option) => matchesModel(current, option))) return current;
      if (draftModel !== null && availableModels.some((option) => matchesModel(draftModel, option))) return draftModel;
      const first = availableModels[0];
      return first !== undefined ? { providerId: first.providerId, modelId: first.modelId } : null;
    });
  }, [availableModels, draftModel]);

  async function handlePickDirectory() {
    const picked = await pickDirectory().catch(() => null);
    if (picked !== null) setCwd(picked);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const trimmedCwd = cwd.trim();
    if (trimmedCwd === "") {
      setError("请填写工作目录");
      return;
    }
    if (toolMode === "all" && !workspaceConfirmed) {
      setError("完整工具模式需要确认工作区授权");
      return;
    }
    if (selectedModel === null && availableModels.length === 0) {
      setError("还没有可用模型，请先在设置中配置 Provider 与 API Key");
      return;
    }

    setBusy(true);
    try {
      const thread = await source.createThread(selectedAgentId, title.trim(), {
        cwd: trimmedCwd,
        toolMode,
        thinkingLevel,
        // 如实传递勾选状态：未确认时服务端降级只读，横幅流程接管
        ...(toolMode === "all" ? { workspaceConfirmed } : {}),
      });
      if (selectedModel !== null) {
        await source.updateSessionModel(thread.id, selectedModel).catch(() => undefined);
      }
      onCreated(thread, selectedAgentId);
    } catch (cause) {
      setError(toUserError(cause, "send").message);
      setBusy(false);
    }
  }

  const activeAgent = agents.find((a) => a.id === selectedAgentId);

  return (
    <div className="new-session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
      <div className="new-session-card">
        <header className="new-session-head">
          <h2 id="new-session-title">高级新建会话</h2>
          <button type="button" className="new-session-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </header>

        <form className="new-session-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="new-session-field">
            <span>标题（可选）</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="留空由首条消息派生"
              disabled={busy}
            />
          </label>

          <label className="new-session-field">
            <span>助理</span>
            <select
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
              disabled={busy || agents.length === 0}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>

          <div className="new-session-field">
            <span>工作目录</span>
            <div className="new-session-directory-row">
              <input
                type="text"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="选择或输入工作目录"
                disabled={busy}
              />
              <button type="button" className="btn" onClick={() => void handlePickDirectory()} disabled={busy}>
                <FolderOpen size={14} />
                浏览…
              </button>
            </div>
          </div>

          <label className="new-session-field">
            <span>工具模式</span>
            <select value={toolMode} onChange={(event) => setToolMode(event.target.value)} disabled={busy}>
              {TOOL_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>{mode.label} — {mode.description}</option>
              ))}
            </select>
          </label>

          {toolMode === "all" && (
            <label className="new-session-check">
              <input
                type="checkbox"
                checked={workspaceConfirmed}
                onChange={(event) => setWorkspaceConfirmed(event.target.checked)}
                disabled={busy}
              />
              确认授权完整工具权限（可写入当前工作目录）
            </label>
          )}

          <label className="new-session-field">
            <span>思考级别</span>
            <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)} disabled={busy}>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>

          <label className="new-session-field">
            <span>模型</span>
            <select
              value={selectedModel === null ? "" : modelKey(selectedModel)}
              onChange={(event) => {
                const ref = parseModelKey(event.target.value);
                setSelectedModel(ref);
              }}
              disabled={busy || availableModels.length === 0}
            >
              {availableModels.length === 0 && <option value="">未配置可用模型</option>}
              {availableModels.map((option) => (
                <option key={modelKey(option)} value={modelKey(option)}>
                  {option.name} ({option.providerId})
                </option>
              ))}
            </select>
          </label>

          {activeAgent?.workspace !== undefined && activeAgent.workspace !== cwd && (
            <p className="new-session-hint">已偏离 {activeAgent.name} 的默认工作目录，将仅用于本会话。</p>
          )}

          {error !== null && <div className="new-session-error" role="alert">{error}</div>}

          <footer className="new-session-footer">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
            <span className="new-session-footer-gap" />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "创建中…" : "创建并进入会话"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
