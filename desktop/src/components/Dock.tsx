import { Bot, FileDiff, FileText, Terminal, X } from "lucide-react";
import { useState } from "react";

import { dockFiles } from "../mock-data.js";
import type { DesktopDataSource } from "../data/source.js";
import { SubagentDock } from "./SubagentDock.js";

export type DockTool = "diff" | "terminal" | "subagent";

const tools: readonly { id: DockTool; label: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "变更审查", icon: FileDiff },
  { id: "terminal", label: "终端", icon: Terminal },
  { id: "subagent", label: "Subagent", icon: Bot },
];

function DiffPanel() {
  const [selected, setSelected] = useState<string>(dockFiles[0]?.path ?? "");
  const file = dockFiles.find((item) => item.path === selected) ?? dockFiles[0];
  return (
    <div className="dock-panel">
      <div className="dock-file-list">
        {dockFiles.map((item) => (
          <button
            key={item.path}
            type="button"
            className={`file-row${item.path === selected ? " is-active" : ""}`}
            onClick={() => setSelected(item.path)}
          >
            <FileText size={13} />
            <span className="file-path">{item.path}</span>
            <span className="file-count"><b>+{item.additions}</b> <i>−{item.deletions}</i></span>
          </button>
        ))}
      </div>
      {file && (
        <pre className="diff-view"><code>
          <span className="diff-head">{file.path}</span>{"\n"}
          {file.diff.map((line, index) => (
            <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : ""}>{line}{"\n"}</span>
          ))}
        </code></pre>
      )}
    </div>
  );
}

function TerminalPanel() {
  return (
    <div className="dock-panel terminal-panel">
      <div className="terminal-meta"><span>opencolorful · powershell</span><span className="chip">mock</span></div>
      <pre className="terminal-view"><code>
        <span className="term-prompt">{"PS <local-workspace>\\opencolorful&gt;"}</span> npm run desktop:build{"\n"}
        {"\n"}
        <span className="term-ok">✓</span> tsc --noEmit{"\n"}
        <span className="term-ok">✓</span> vite build · 412 kB{"\n"}
        {"\n"}
        <span className="term-prompt">{"PS <local-workspace>\\opencolorful&gt;"}</span> <span className="term-caret" />
      </code></pre>
    </div>
  );
}

interface DockToggleProps {
  readonly dock: DockTool | null;
  readonly onToggle: (tool: DockTool) => void;
}

export function DockToggleButtons({ dock, onToggle }: DockToggleProps) {
  return (
    <div className="dock-toggles">
      {tools.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={`icon-btn${dock === id ? " is-active" : ""}`}
          aria-label={label}
          title={label}
          onClick={() => onToggle(id)}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

interface DockProps {
  readonly tool: DockTool;
  readonly onSelect: (tool: DockTool) => void;
  readonly onClose: () => void;
  readonly subagent?: {
    readonly source: DesktopDataSource;
    readonly agentId: string;
    readonly sessionId: string | null;
  };
}

export function Dock({ tool, onSelect, onClose, subagent }: DockProps) {
  return (
    <aside className="dock" aria-label="工作台">
      <header className="dock-head">
        <div className="dock-tabs">
          {tools.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={tool === id ? "is-active" : ""} onClick={() => onSelect(id)}>
              <Icon size={13} />{label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="关闭工作台" title="关闭工作台" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {tool === "diff" ? (
        <DiffPanel />
      ) : tool === "terminal" ? (
        <TerminalPanel />
      ) : subagent !== undefined ? (
        <SubagentDock {...subagent} />
      ) : (
        <div className="dock-panel"><p className="page-empty">当前会话无 Subagent 上下文</p></div>
      )}
    </aside>
  );
}
