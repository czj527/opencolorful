import type { SupervisorStatusResponse } from "../lib/types.js";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Square, RotateCw, Loader2 } from "lucide-react";

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
      <button
        className="icon-button"
        onClick={onToggleLeft}
        type="button"
        aria-label={leftCollapsed ? "展开会话面板" : "收起会话面板"}
        title={leftCollapsed ? "展开会话面板" : "收起会话面板"}
      >
        {leftCollapsed ? <PanelLeftOpen size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
      </button>

      <span className={`status-dot ${connectionStatus}`} aria-hidden="true" />
      <span data-testid="connection-status">
        {connectionStatus === "online" && "已连接"}
        {connectionStatus === "stopped" && "已停止"}
        {connectionStatus === "error" && "错误"}
        {connectionStatus === "connecting" && "连接中…"}
      </span>

      {agentPort !== null && agentPort !== undefined && (
        <span style={{ color: "var(--text-secondary)" }} data-testid="agent-port">:{agentPort}</span>
      )}
      {version && <span style={{ color: "var(--text-secondary)" }}>v{version}</span>}

      <div style={{ flex: 1 }} />

      {agentStatus === "stopped" && (
        <button
          className="icon-button primary"
          onClick={onStart}
          type="button"
          aria-label="启动 Server"
          title="启动 Agent Server"
        >
          <Play size={14} aria-hidden="true" />
          启动
        </button>
      )}
      {agentStatus === "online" && (
        <>
          <button
            className="icon-button danger"
            onClick={onStop}
            type="button"
            aria-label="停止 Server"
            title="停止 Agent Server"
          >
            <Square size={14} aria-hidden="true" />
            停止
          </button>
          <button
            className="icon-button"
            onClick={onRestart}
            type="button"
            aria-label="重启 Server"
            title="重启 Agent Server"
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
        </>
      )}
      {(agentStatus === "starting" || agentStatus === "degraded") && (
        <Loader2 size={14} className="spinner-icon" aria-label="处理中" />
      )}

      <button
        className="icon-button"
        onClick={onToggleRight}
        type="button"
        aria-label={rightCollapsed ? "展开详情面板" : "收起详情面板"}
        title={rightCollapsed ? "展开详情面板" : "收起详情面板"}
      >
        {rightCollapsed ? <PanelRightOpen size={14} aria-hidden="true" /> : <PanelRightClose size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
