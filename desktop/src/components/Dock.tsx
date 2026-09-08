import { Bot, X } from "lucide-react";

import type { DesktopDataSource } from "../data/source.js";
import { SubagentDock } from "./SubagentDock.js";

/**
 * P1 审计修复（§7.5/§10-10）：Diff 与 Terminal 面板是纯静态演示
 * （固定 dockFiles / 固定文本），在真实 IPC 模式出现会让用户误以为
 * 查看了真实 Diff 或运行了真实 Terminal——入口按钮与静态面板一并移除，
 * Dock 收敛为真实接线的 Subagent 检查器；两者接真实数据后再以
 * 新面板形态回归（不保留"演示态"假入口）。
 */

export type DockTool = "subagent";

interface DockToggleProps {
  readonly dock: DockTool | null;
  readonly onToggle: (tool: DockTool) => void;
}

export function DockToggleButtons({ dock, onToggle }: DockToggleProps) {
  return (
    <div className="dock-toggles">
      <button
        type="button"
        className={`icon-btn${dock === "subagent" ? " is-active" : ""}`}
        aria-label="Subagent"
        title="Subagent"
        onClick={() => onToggle("subagent")}
      >
        <Bot size={15} />
      </button>
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

export function Dock({ onSelect, onClose, subagent }: DockProps) {
  return (
    <aside className="dock" aria-label="工作台">
      <header className="dock-head">
        <div className="dock-tabs">
          <button type="button" className="is-active" onClick={() => onSelect("subagent")}>
            <Bot size={13} />Subagent
          </button>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭工作台" title="关闭工作台" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {subagent !== undefined ? (
        <SubagentDock {...subagent} />
      ) : (
        <div className="dock-panel"><p className="page-empty">当前会话无 Subagent 上下文</p></div>
      )}
    </aside>
  );
}
