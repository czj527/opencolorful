import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiClient } from "../lib/api-client.js";
import { SseClient } from "../lib/sse-client.js";
import { WsClient } from "../lib/ws-client.js";
import type { PlatformEventEnvelope, LayoutPreferences, AgentView } from "../lib/types.js";
import { appReducer, initialAppState } from "./state.js";
import { chatReducer, initialChatState, getStreamCursor, buildChatStateFromHistory } from "../features/chat/chat-state.js";
import { ServerStatusBar } from "../components/ServerStatusBar.jsx";
import { SessionSidebar } from "../components/SessionSidebar.jsx";
import { ChatPane } from "../components/ChatPane.jsx";
import { InspectorSidebar } from "../components/InspectorSidebar.jsx";
import { usePanelResize } from "../features/layout/use-panel-resize.js";
import {
  mergeLayoutPreferences,
  DEFAULT_LAYOUT_ONLY,
  getSidebarPresentation,
  isDrawerBackdropOpen,
  resolveReducedMotion,
  withSidebarCollapsed,
} from "../features/layout/layout-preferences.js";
import { StreamBuffer } from "../features/chat/stream-buffer.js";
import "./layout.css";

// 同源部署：Supervisor 托管 Web 并代理 Agent API
const API_BASE = "";

const NARROW_LEFT_QUERY = "(max-width: 768px)";
const NARROW_RIGHT_QUERY = "(max-width: 1024px)";

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
}

function applyLayoutVars(layout: LayoutPreferences, reducedMotion: boolean) {
  document.documentElement.style.setProperty("--left-sidebar-width", `${layout.leftSidebarWidth}px`);
  document.documentElement.style.setProperty("--right-sidebar-width", `${layout.rightSidebarWidth}px`);
  document.documentElement.style.setProperty(
    "--transition-duration",
    reducedMotion ? "0ms" : "0.2s",
  );
}

export interface WorkspaceAppProps {
  readonly onSettingsClick: () => void;
  readonly active: boolean;
}

export function WorkspaceApp({ onSettingsClick, active }: WorkspaceAppProps) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialAppState,
    // 窄屏默认收起侧栏，避免首屏抽屉互相覆盖
    leftSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches ? "collapsed" as const : "expanded" as const,
    rightSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_RIGHT_QUERY).matches ? "collapsed" as const : "expanded" as const,
  }));
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const [sseConnected, setSseConnected] = useState(false);
  const [layoutPrefs, setLayoutPrefs] = useState<LayoutPreferences>(DEFAULT_LAYOUT_ONLY);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [breakpoints, setBreakpoints] = useState(() => ({
    leftNarrow: typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches,
    rightNarrow: typeof window !== "undefined" && window.matchMedia(NARROW_RIGHT_QUERY).matches,
  }));
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const apiRef = useRef(new ApiClient(API_BASE));
  const sseRef = useRef<SseClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const leftResizeRef = useRef<HTMLDivElement | null>(null);
  const rightResizeRef = useRef<HTMLDivElement | null>(null);
  const bufferRef = useRef<StreamBuffer | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const api = apiRef.current;

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    api.getPreferences().then((prefs) => {
      if (cancelled) return;
      const layout = mergeLayoutPreferences(prefs.layout, DEFAULT_LAYOUT_ONLY);
      setLayoutPrefs(layout);
      applyTheme(prefs.appearance.theme);
      setShowThinking(prefs.appearance.showThinking ?? true);
      setShowToolCalls(prefs.appearance.showToolCalls ?? true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, api]);

  useEffect(() => {
    const leftQuery = window.matchMedia(NARROW_LEFT_QUERY);
    const rightQuery = window.matchMedia(NARROW_RIGHT_QUERY);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setBreakpoints({ leftNarrow: leftQuery.matches, rightNarrow: rightQuery.matches });
      setSystemReducedMotion(motionQuery.matches);
      setViewportWidth(window.innerWidth);
    };
    leftQuery.addEventListener("change", sync);
    rightQuery.addEventListener("change", sync);
    motionQuery.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      leftQuery.removeEventListener("change", sync);
      rightQuery.removeEventListener("change", sync);
      motionQuery.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  const reducedMotion = resolveReducedMotion(layoutPrefs.reducedMotion, systemReducedMotion);

  useEffect(() => {
    applyLayoutVars(layoutPrefs, reducedMotion);
    const presentation = getSidebarPresentation(layoutPrefs, breakpoints);
    dispatch({
      type: "SET_LEFT_SIDEBAR",
      payload: presentation.leftCollapsed ? "collapsed" : "expanded",
    });
    dispatch({
      type: "SET_RIGHT_SIDEBAR",
      payload: presentation.rightCollapsed ? "collapsed" : "expanded",
    });
  }, [layoutPrefs, breakpoints, reducedMotion]);

  // --- 数据加载 ---

  const refreshSupervisorStatus = useCallback(async () => {
    try {
      const status = await api.getSupervisorStatus();
      dispatch({ type: "SET_SUPERVISOR_STATUS", payload: status });
    } catch {
      // Supervisor 的轮询请求短暂失败时仍可恢复，不把网络抖动误报成服务端硬错误。
      dispatch({ type: "SET_CONNECTION_STATUS", payload: "degraded" });
    }
  }, [api]);

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await api.listSessions({ includeArchived: true });
      dispatch({ type: "SET_SESSIONS", payload: sessions });
    } catch {
      // Server 可能未运行
    }
  }, [api]);

  const refreshProvidersAndModels = useCallback(async () => {
    try {
      const [providers, models] = await Promise.all([api.listProviders(), api.listModels()]);
      dispatch({ type: "SET_PROVIDERS", payload: providers });
      dispatch({ type: "SET_MODELS", payload: models });
    } catch {
      // Server 可能未运行
    }
  }, [api]);

  const refreshAgents = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list);
    } catch {
      // Server 可能未运行
    }
  }, [api]);

  useEffect(() => {
    if (!active) return undefined;
    void refreshSupervisorStatus();
    const interval = setInterval(() => void refreshSupervisorStatus(), 5_000);
    return () => clearInterval(interval);
  }, [active, refreshSupervisorStatus]);

  useEffect(() => {
    if (active && state.connectionStatus === "online") {
      void refreshSessions();
      void refreshProvidersAndModels();
      void refreshAgents();
      // Agent 在线期间定期刷新模型与 Provider（Provider 可能在运行中被配置）
      const interval = setInterval(() => {
        void refreshProvidersAndModels();
      }, 10_000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [active, state.connectionStatus, refreshSessions, refreshProvidersAndModels]);

  // --- 事件流接线：SSE/WS 事件 → StreamBuffer → chatReducer EVENT_BATCH ---

  useEffect(() => {
    const buffer = new StreamBuffer((events) => {
      dispatchChat({ type: "EVENT_BATCH", events });
      for (const e of events) {
        if (e.type === "message.completed" || e.type === "session.status") {
          void refreshSessions();
          break;
        }
      }
    });
    bufferRef.current = buffer;
    return () => buffer.dispose();
  }, []);

  const handlePlatformEvent = useCallback((event: PlatformEventEnvelope) => {
    bufferRef.current?.push(event);
  }, []);

  useEffect(() => {
    if (active && state.activeSessionId && state.connectionStatus === "online") {
      const sessionId = state.activeSessionId;

      sseRef.current?.dispose();
      const sse = new SseClient({
        baseUrl: API_BASE || window.location.origin,
        sessionId,
        onEvent: handlePlatformEvent,
        onReset: () => {
          // 缓存截断：重置聊天状态，从历史重新加载
          dispatchChat({ type: "RESET" });
          void refreshSessions();
        },
        onOpen: () => setSseConnected(true),
        onError: () => setSseConnected(false),
      });
      sse.connect();
      sseRef.current = sse;

      wsRef.current?.dispose();
      const ws = new WsClient({
        baseUrl: API_BASE || window.location.origin,
        onEvent: handlePlatformEvent,
        onOpen: () => {
          // WS（重）连后：订阅会话并按 stream 游标 Resume 补发缺失事件
          ws.subscribe(sessionId);
          const { currentStreamId } = chatRef.current;
          if (currentStreamId !== null) {
            const cursor = getStreamCursor(chatRef.current, currentStreamId);
            ws.resume(sessionId, currentStreamId, cursor);
          }
        },
      });
      ws.connect();
      wsRef.current = ws;

      return () => {
        setSseConnected(false);
        sse.dispose();
        ws.dispose();
      };
    }
    return undefined;
  }, [active, state.activeSessionId, state.connectionStatus, handlePlatformEvent, refreshSessions]);

  // --- 会话操作 ---

  const handleSelectSession = useCallback(async (id: string) => {
    dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
    try {
      const session = await api.getSession(id);
      dispatch({ type: "UPSERT_SESSION", payload: session });
      // Agent 跟随会话：用 session.agentId 更新 activeAgentId
      setActiveAgentId(session.agentId ?? null);
      // 从历史 messageEntries 重建 chat state（timeline、toolCalls、thinking）
      if (session.messageEntries.length > 0) {
        const historyState = buildChatStateFromHistory(session.messageEntries);
        dispatchChat({ type: "LOAD_HISTORY", state: historyState });
      } else {
        dispatchChat({ type: "RESET" });
      }
      // WS 订阅该会话
      if (wsRef.current?.isConnected()) {
        wsRef.current.subscribe(id);
      }
    } catch { /* 会话可能不存在 */ }
  }, [api]);

  const handleCreateSession = useCallback(async (title: string, cwd: string) => {
    try {
      const settings = activeAgentId !== null ? { agentId: activeAgentId } : undefined;
      const session = await api.createSession(title, cwd, settings);
      dispatch({ type: "UPSERT_SESSION", payload: session });
      dispatch({ type: "SET_ACTIVE_SESSION", payload: session.id });
      dispatchChat({ type: "RESET" });
    } catch (error) {
      dispatch({ type: "SET_ERROR", payload: error instanceof Error ? error.message : "创建会话失败" });
    }
  }, [api, activeAgentId]);

  const handleArchiveSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id);
      if (state.activeSessionId === id) {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
        dispatchChat({ type: "RESET" });
      }
      await refreshSessions();
    } catch { /* 忽略 */ }
  }, [api, state.activeSessionId, refreshSessions]);

  const handleUnarchiveSession = useCallback(async (id: string) => {
    try {
      await api.unarchiveSession(id);
      await refreshSessions();
    } catch { /* 忽略 */ }
  }, [api, refreshSessions]);

  // --- Prompt 生命周期 ---

  const handleSend = useCallback(async (content: string) => {
    if (!state.activeSessionId) return;
    const sessionId = state.activeSessionId;
    dispatchChat({ type: "PROMPT_PENDING", userContent: content });
    try {
      const result = await api.sendPrompt(sessionId, content);
      dispatchChat({ type: "PROMPT_SENT", streamId: result.streamId, userContent: content });
      // WS 订阅（幂等）确保收到控制事件
      if (wsRef.current && !wsRef.current.isSubscribed(sessionId)) {
        wsRef.current.subscribe(sessionId);
      }
    } catch (error) {
      dispatchChat({ type: "SET_ERROR", error: error instanceof Error ? error.message : "发送失败" });
    }
  }, [api, state.activeSessionId]);

  const handleAbort = useCallback(async () => {
    if (!state.activeSessionId || !chat.currentStreamId) return;
    const sessionId = state.activeSessionId;
    const streamId = chat.currentStreamId;
    try {
      await api.abort(sessionId, streamId);
    } catch {
      // 通过 WS 兜底
      wsRef.current?.abort(sessionId);
    }
  }, [api, state.activeSessionId, chat.currentStreamId]);

  const handleSelectModel = useCallback(async (providerId: string, modelId: string) => {
    if (!state.activeSessionId) return;
    try {
      const session = await api.setSessionModel(state.activeSessionId, providerId, modelId);
      dispatch({ type: "UPSERT_SESSION", payload: session });
    } catch (error) {
      dispatch({ type: "SET_ERROR", payload: error instanceof Error ? error.message : "模型设置失败" });
    }
  }, [api, state.activeSessionId]);

  // --- 设置操作 ---

  const handleToolModeChange = useCallback(async (mode: string) => {
    if (!state.activeSessionId) return;
    const session = await api.updateSessionSettings(state.activeSessionId, { toolMode: mode as "off" | "read-only" | "all" });
    dispatch({ type: "UPSERT_SESSION", payload: session });
  }, [api, state.activeSessionId]);

  const handleThinkingLevelChange = useCallback(async (level: string) => {
    if (!state.activeSessionId) return;
    const session = await api.updateSessionSettings(state.activeSessionId, { thinkingLevel: level });
    dispatch({ type: "UPSERT_SESSION", payload: session });
  }, [api, state.activeSessionId]);

  // --- Agent 选择 ---

  const handleSelectAgent = useCallback(async (agentId: string | null) => {
    setActiveAgentId(agentId);
    if (agentId === null) {
      // "默认（无 Agent）"：切换到无 Agent 的最近会话或清空
      const nullAgentSessions = state.sessions.filter((s) => s.agentId === null);
      if (nullAgentSessions.length > 0) {
        const recent = nullAgentSessions.reduce((a, b) =>
          a.updatedAt > b.updatedAt ? a : b
        );
        await handleSelectSession(recent.id);
      } else {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
        dispatchChat({ type: "RESET" });
      }
      return;
    }
    // 切换到指定 Agent：加载其最近会话，否则进入空状态
    try {
      const agentSessions = await api.getAgentSessions(agentId);
      if (agentSessions.length > 0) {
        const recent = agentSessions.reduce((a, b) =>
          a.updatedAt > b.updatedAt ? a : b
        );
        await handleSelectSession(recent.id);
      } else {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
        dispatchChat({ type: "RESET" });
      }
    } catch {
      dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
      dispatchChat({ type: "RESET" });
    }
  }, [api, state.sessions, handleSelectSession]);

  // --- Supervisor 操作 ---

  const handleStart = useCallback(async () => {
    await api.startAgentServer().catch(() => {});
    await refreshSupervisorStatus();
  }, [api, refreshSupervisorStatus]);

  const handleStop = useCallback(async () => {
    await api.stopAgentServer().catch(() => {});
    await refreshSupervisorStatus();
  }, [api, refreshSupervisorStatus]);

  const handleRestart = useCallback(async () => {
    await api.restartAgentServer().catch(() => {});
    await refreshSupervisorStatus();
  }, [api, refreshSupervisorStatus]);

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const leftCollapsed = state.leftSidebar === "collapsed";
  const rightCollapsed = state.rightSidebar === "collapsed";
  const focusMode = leftCollapsed && rightCollapsed;
  const drawerOpen = isDrawerBackdropOpen(breakpoints, { leftCollapsed, rightCollapsed });
  const leftMaxWidth = Math.max(
    200,
    Math.min(420, viewportWidth - (rightCollapsed ? 0 : layoutPrefs.rightSidebarWidth) - 430),
  );
  const rightMaxWidth = Math.max(
    240,
    Math.min(520, viewportWidth - (leftCollapsed ? 0 : layoutPrefs.leftSidebarWidth) - 430),
  );

  // 拖拽调整大小（依赖 leftCollapsed/rightCollapsed，放在声明之后）
  const onResizeLeft = useCallback((w: number) => {
    setLayoutPrefs((prev) => ({ ...prev, leftSidebarWidth: w }));
    document.documentElement.style.setProperty("--left-sidebar-width", `${w}px`);
  }, []);
  const onResizeLeftEnd = useCallback((w: number) => {
    api.updatePreferences({ layout: { leftSidebarWidth: w } }).catch(() => {});
  }, [api]);
  const leftResize = usePanelResize(leftResizeRef, {
    side: "left", minWidth: 200, maxWidth: leftMaxWidth,
    currentWidth: layoutPrefs.leftSidebarWidth,
    onResize: onResizeLeft, onResizeEnd: onResizeLeftEnd,
    disabled: leftCollapsed,
  });

  const onResizeRight = useCallback((w: number) => {
    setLayoutPrefs((prev) => ({ ...prev, rightSidebarWidth: w }));
    document.documentElement.style.setProperty("--right-sidebar-width", `${w}px`);
  }, []);
  const onResizeRightEnd = useCallback((w: number) => {
    api.updatePreferences({ layout: { rightSidebarWidth: w } }).catch(() => {});
  }, [api]);
  const rightResize = usePanelResize(rightResizeRef, {
    side: "right", minWidth: 240, maxWidth: rightMaxWidth,
    currentWidth: layoutPrefs.rightSidebarWidth,
    onResize: onResizeRight, onResizeEnd: onResizeRightEnd,
    disabled: rightCollapsed,
  });

  // 窄屏一次只打开一个抽屉：打开一侧时收起另一侧
  const handleToggleLeft = useCallback(() => {
    const opening = state.leftSidebar === "collapsed";
    const nextCollapsed = !leftCollapsed;
    dispatch({ type: "SET_LEFT_SIDEBAR", payload: nextCollapsed ? "collapsed" : "expanded" });
    if (!breakpoints.leftNarrow) {
      const nextLayout = withSidebarCollapsed(layoutPrefs, "left", nextCollapsed);
      setLayoutPrefs(nextLayout);
      api.updatePreferences({
        layout: { leftCollapsed: nextLayout.leftCollapsed, focusMode: nextLayout.focusMode },
      }).catch(() => {});
    }
    if (opening && breakpoints.leftNarrow && state.rightSidebar === "expanded") {
      dispatch({ type: "SET_RIGHT_SIDEBAR", payload: "collapsed" });
    }
  }, [state.leftSidebar, state.rightSidebar, leftCollapsed, breakpoints.leftNarrow, api, layoutPrefs]);

  const handleToggleRight = useCallback(() => {
    const opening = state.rightSidebar === "collapsed";
    const nextCollapsed = !rightCollapsed;
    dispatch({ type: "SET_RIGHT_SIDEBAR", payload: nextCollapsed ? "collapsed" : "expanded" });
    if (!breakpoints.rightNarrow) {
      const nextLayout = withSidebarCollapsed(layoutPrefs, "right", nextCollapsed);
      setLayoutPrefs(nextLayout);
      api.updatePreferences({
        layout: { rightCollapsed: nextLayout.rightCollapsed, focusMode: nextLayout.focusMode },
      }).catch(() => {});
    }
    if (opening && breakpoints.leftNarrow && state.leftSidebar === "expanded") {
      dispatch({ type: "SET_LEFT_SIDEBAR", payload: "collapsed" });
    }
  }, [state.leftSidebar, state.rightSidebar, rightCollapsed, breakpoints, api, layoutPrefs]);

  const closeDrawers = useCallback(() => {
    if (breakpoints.leftNarrow && state.leftSidebar === "expanded") {
      dispatch({ type: "SET_LEFT_SIDEBAR", payload: "collapsed" });
    }
    if (breakpoints.rightNarrow && state.rightSidebar === "expanded") {
      dispatch({ type: "SET_RIGHT_SIDEBAR", payload: "collapsed" });
    }
  }, [breakpoints, state.leftSidebar, state.rightSidebar]);

  useEffect(() => {
    if (!active || !drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, drawerOpen, closeDrawers]);

  return (
    <div
      className="app-layout"
      data-focus-mode={focusMode ? "true" : undefined}
      data-workspace-active={active ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <ServerStatusBar
        status={state.supervisorStatus}
        connectionStatus={state.connectionStatus}
        onStart={handleStart}
        onStop={handleStop}
        onRestart={handleRestart}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
      />
      <div className="app-main">
        {drawerOpen && (
          <div
            className="drawer-backdrop"
            onClick={closeDrawers}
            aria-hidden="true"
            data-testid="drawer-backdrop"
          />
        )}
        <SessionSidebar
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          collapsed={leftCollapsed}
          onSelect={(id) => void handleSelectSession(id)}
          onCreate={(title, cwd) => void handleCreateSession(title, cwd)}
          onArchive={(id) => void handleArchiveSession(id)}
          onUnarchive={(id) => void handleUnarchiveSession(id)}
          onToggle={handleToggleLeft}
          agents={agents}
          activeAgentId={activeAgentId}
          onSelectAgent={(id) => void handleSelectAgent(id)}
        />
        {!focusMode && !breakpoints.leftNarrow && (
          <div ref={leftResizeRef} className="resize-handle" {...leftResize.resizeHandleProps} />
        )}
        <ChatPane
          session={activeSession}
          chat={chat}
          models={state.models}
          onSend={(content) => void handleSend(content)}
          onAbort={() => void handleAbort()}
          onToggleThinking={(id) => dispatchChat({ type: "TOGGLE_THINKING", id })}
          onSelectModel={(providerId, modelId) => void handleSelectModel(providerId, modelId)}
          onToolModeChange={(mode) => void handleToolModeChange(mode)}
          onThinkingLevelChange={(level) => void handleThinkingLevelChange(level)}
          sseConnected={sseConnected && state.connectionStatus === "online"}
          onSettingsClick={onSettingsClick}
          reducedMotion={reducedMotion}
          showThinking={showThinking}
          showToolCalls={showToolCalls}
        />
        {!focusMode && !breakpoints.rightNarrow && (
          <div ref={rightResizeRef} className="resize-handle" {...rightResize.resizeHandleProps} />
        )}
        <InspectorSidebar
          collapsed={rightCollapsed}
          onToggle={handleToggleRight}
        />
      </div>
    </div>
  );
}
