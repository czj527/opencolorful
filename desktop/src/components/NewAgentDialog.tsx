import { FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Agent } from "../mock-data.js";
import { pickDirectory } from "../data/pick-directory.js";
import type { AgentTemplateView, DesktopDataSource } from "../data/source.js";
import { toUserError } from "../errors.js";
import "./NewAgentDialog.css";

interface NewAgentDialogProps {
  readonly source: DesktopDataSource;
  readonly onCreated: (agent: Agent) => void;
  readonly onClose: () => void;
}

/**
 * T9：新建助理（精简版 onboarding 第 1 步）：名字 + 底色模板 + 可选默认工作目录。
 * 入口：空态"新建助理…"、高级新建表单的助理选择器底部。
 */
export function NewAgentDialog({ source, onCreated, onClose }: NewAgentDialogProps) {
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<readonly AgentTemplateView[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    source.listAgentTemplates().then((list) => {
      if (cancelled) return;
      setTemplates(list);
      setTemplateKey((current) => current !== "" ? current : list[0]?.key ?? "");
    }).catch(() => {
      if (!cancelled) setTemplates([]);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  async function handlePickDirectory() {
    const picked = await pickDirectory().catch(() => null);
    if (picked !== null) setCwd(picked);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("请给助理起个名字");
      return;
    }
    const template = templates.find((item) => item.key === templateKey);
    if (template === undefined) {
      setError("请选择一个底色模板");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const agent = await source.createAgent({
        name: trimmed,
        baseColor: template.baseColor,
        ...(cwd.trim() !== "" ? { defaultCwd: cwd.trim() } : {}),
      });
      onCreated(agent);
    } catch (cause) {
      setError(toUserError(cause, "createAgent").message);
      setBusy(false);
    }
  }

  return (
    <div className="new-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="new-agent-title">
      <div className="new-agent-card">
        <header className="new-agent-head">
          <h2 id="new-agent-title">新建助理</h2>
          <button type="button" className="new-agent-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </header>

        <form className="new-agent-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="new-agent-field">
            <span>名字</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="比如：小彩"
              maxLength={50}
              disabled={busy}
              autoFocus
            />
          </label>

          <div className="new-agent-field">
            <span>底色模板</span>
            <div className="new-agent-templates" role="radiogroup" aria-label="底色模板">
              {templates.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  role="radio"
                  aria-checked={template.key === templateKey}
                  className={`new-agent-template${template.key === templateKey ? " is-active" : ""}`}
                  onClick={() => setTemplateKey(template.key)}
                  disabled={busy}
                >
                  <i style={{ background: template.color }} aria-hidden="true" />
                  <span>
                    <strong>{template.label}</strong>
                    <small>{template.description}</small>
                  </span>
                </button>
              ))}
              {templates.length === 0 && <p className="page-empty">模板加载中…</p>}
            </div>
          </div>

          <div className="new-agent-field">
            <span>默认工作目录（可选）</span>
            <div className="new-agent-directory-row">
              <input
                type="text"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="助理默认操作的目录"
                disabled={busy}
              />
              <button type="button" className="btn" onClick={() => void handlePickDirectory()} disabled={busy}>
                <FolderOpen size={14} />
                浏览…
              </button>
            </div>
          </div>

          {error !== null && <div className="new-agent-error" role="alert">{error}</div>}

          <footer className="new-agent-footer">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
            <span className="new-agent-footer-gap" />
            <button type="submit" className="btn btn-primary" disabled={busy || templates.length === 0}>
              {busy ? "创建中…" : "创建助理"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
