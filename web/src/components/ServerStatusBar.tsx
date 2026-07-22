import type { SupervisorStatusResponse } from "../lib/types.js";
import { IconButton } from "./IconButton.jsx";

interface ServerStatusBarProps {
  readonly status: SupervisorStatusResponse | null;
  readonly connectionStatus: "connecting" | "online" | "stopped" | "error";
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRestart: () => void;
  readonly onToggleLeft: () => void;
  readonly onToggleRight: () => void;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
}

export function ServerStatusBar({
  status,
  connectionStatus,
  onStart,
  onStop,
  onRestart,
  onToggleLeft,
  onToggleRight,
  leftCollapsed,
  rightCollapsed,
}: ServerStatusBarProps) {
  const agentStatus = status?.agentServer.status ?? "stopped";
  const agentPort = status?.agentServer.port;
  const version = status?.supervisor.version;

  return (
    <div className="app-statusbar" role="banner">
      <IconButton
        icon={leftCollapsed ? "»" : "«"}
        label={leftCollapsed ? "展开会话面板" : "收起会话面板"}
        onClick={onToggleLeft}
        title={leftCollapsed ? "展开会话面板" : "收起会话面板"}
      />

      <span className={`status-dot ${connectionStatus}`} aria-hidden="true" />
      <span>
        {connectionStatus === "online" && "已连接"}
        {connectionStatus === "stopped" && "已停止"}
        {connectionStatus === "error" && "错误"}
        {connectionStatus === "connecting" && "连接中..."}
      </span>

      {agentPort && <span style={{ color: "var(--text-secondary)" }}>:{agentPort}</span>}
      {version && <span style={{ color: "var(--text-secondary)" }}>v{version}</span>}

      <div style={{ flex: 1 }} />

      {agentStatus === "stopped" && (
        <IconButton icon="▶" label="启动 Server" onClick={onStart} variant="primary" title="启动 Agent Server" />
      )}
      {agentStatus === "online" && (
        <>
          <IconButton icon="■" label="停止 Server" onClick={onStop} variant="danger" title="停止 Agent Server" />
          <IconButton icon="↻" label="重启 Server" onClick={onRestart} title="重启 Agent Server" />
        </>
      )}
      {(agentStatus === "starting" || agentStatus === "degraded") && (
        <span className="spinner" aria-label="处理中" />
      )}

      <IconButton
        icon={rightCollapsed ? "«" : "»"}
        label={rightCollapsed ? "展开检查面板" : "收起检查面板"}
        onClick={onToggleRight}
        title={rightCollapsed ? "展开检查面板" : "收起检查面板"}
      />
    </div>
  );
}
