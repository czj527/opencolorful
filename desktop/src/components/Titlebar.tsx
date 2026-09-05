import { BookOpen, MessageSquare, Minus, Moon, ScrollText, Square, Sun, X } from "lucide-react";

import type { ConnectionInfo } from "../data/source.js";
import type { ThemeController } from "../theme.js";

export type PageId = "chat" | "memory" | "logs" | "onboarding" | "profile" | "usage";

// onboarding / profile 是隐藏路由（不进顶栏页签）：onboarding 由首启检测驱动，profile 由侧栏身份证卡进入
const pages: readonly { id: PageId; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "memory", label: "记忆", icon: BookOpen },
  { id: "logs", label: "日志", icon: ScrollText },
];

interface TitlebarProps {
  readonly page: PageId;
  readonly onPage: (page: PageId) => void;
  readonly theme: ThemeController;
  readonly streaming: boolean;
  readonly connection: ConnectionInfo;
}

export function Titlebar({ page, onPage, theme, streaming, connection }: TitlebarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <span className="brand"><span className="brand-dot" aria-hidden="true" />OpenColorful</span>
        <nav className="page-tabs" aria-label="工作页面">
          {pages.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={page === id ? "is-active" : ""} onClick={() => onPage(id)}>
              <Icon size={13} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="titlebar-right">
        <span className={`runtime-state${streaming ? " is-busy" : ""}${connection.connected ? "" : " is-offline"}`}>
          <i aria-hidden="true" />{streaming ? "运行中" : connection.label}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={theme.resolved === "dark" ? "切换为浅色主题" : "切换为深色主题"}
          title={theme.mode === "system" ? `跟随系统（当前${theme.resolved === "dark" ? "深色" : "浅色"}）` : undefined}
          onClick={theme.toggle}
        >
          {theme.resolved === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" onClick={() => window.desktopShell?.minimize()}><Minus size={14} /></button>
          <button type="button" aria-label="最大化" onClick={() => window.desktopShell?.toggleMaximize()}><Square size={12} /></button>
          <button type="button" aria-label="关闭" className="window-close" onClick={() => window.desktopShell?.close()}><X size={14} /></button>
        </div>
      </div>
    </header>
  );
}
