import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiClient, ApiClientError } from "../lib/api-client.js";
import { SseClient } from "../lib/sse-client.js";
import { WsClient } from "../lib/ws-client.js";
import type { PlatformEventEnvelope, AgentView, SubagentThreadId } from "../lib/types.js";
import { appReducer, initialAppState } from "./state.js";
import { chatReducer, initialChatState, getStreamCursor, buildChatStateFromHistory } from "../features/chat/chat-state.js";
import { executeCommand, type CommandName } from "../features/chat/commands.js";
import { ServerStatusBar } from "../components/ServerStatusBar.jsx";
import { SessionSidebar } from "../components/SessionSidebar.jsx";
import { ChatPane } from "../components/ChatPane.jsx";
import { InspectorSidebar } from "../components/InspectorSidebar.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { SubagentPanel } from "../features/subagents/SubagentPanel.jsx";
import type { SubagentParentRequestAction } from "../features/subagents/SubagentCard.jsx";
import { useSubagentThreads } from "../features/subagents/use-subagent-threads.js";
import { useLayoutState, NARROW_LEFT_QUERY, NARROW_RIGHT_QUERY } from "../features/layout/useLayoutState.js";
import { StreamBuffer } from "../features/chat/stream-buffer.js";
import { navigateToWorkspace } from "./page-router.js";
import "./layout.css";

// 同源部署：Supervisor 托管 Web 并代理 Agent API
const API_BASE = "";

export interface WorkspaceAppProps {
  readonly onSettingsClick: () => void;
  readonly active: boolean;
  /**
   * NewSessionPage 创建会话成功后由 App 透传的 sessionId。
   * WorkspaceApp 检测到非空值时（且自身 active）会将其设为 activeSession、
   * 加载 chat state，并调用 onSessionCreatedConsumed 清空状态。
   */
  readonly createdSessionId?: string | null;
  readonly onSessionCreatedConsumed?: () => void;
}

export function WorkspaceApp({
  onSettingsClick,
  active,
  createdSessionId,
  onSessionCreatedConsumed,
}: WorkspaceAppProps) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialAppState,
    // 窄屏默认收起侧栏，避免首屏抽屉互相覆盖
    leftSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches ? "collapsed" as const : "expanded" as const,
    rightSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_RIGHT_QUERY).matches ? "collapsed" as const : "expanded" as const,
  }));
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const [sseConnected, setSseConnected] = useState(false);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [timelineVisible, setTimelineVisible] = useState(true);
  // Phase 14（§21.2）：右侧面板当前选中的 Subagent Thread（null=关闭）
  const [selectedSubagentThreadId, setSelectedSubagentThreadId] = useState<SubagentThreadId | null>(null);
  const apiRef = useRef(new ApiClient(API_BASE));
  const sseRef = useRef<SseClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const bufferRef = useRef<StreamBuffer | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const api = apiRef.current;

  // 布局状态：断点 / reducedMotion / viewport / 侧栏开关 / 主题 / CSS 变量 / resize
  // 全部封装在 useLayoutState，本组件只持有业务数据与会话事件接线。
  const layout = useLayoutState({
    active,
    api,
    dispatchSidebar: dispatch,
    leftSidebar: state.leftSidebar,
    rightSidebar: state.rightSidebar,
    onPreferencesLoaded: useCallback((appearance) => {
      setShowThinking(appearance.showThinking);
      setShowToolCalls(appearance.showToolCalls);
      if (appearance.timelineVisible !== undefined) {
        setTimelineVisible(appearance.timelineVisible);
      }
    }, []),
  });

  // --- 数据加载 ---

  const refreshSupervisorStatus = useCallback(async () => {
    try {
      const status = await api.getSupervisorStatus();
      dispatch({ type: "SET_SUPERVISOR_STATUS", payload: status });
    } catch {
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
      const interval = setInterval(() => {
        void refreshProvidersAndModels();
      }, 10_000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [active, state.connectionStatus, refreshSessions, refreshProvidersAndModels]);

  // --- 事件流接线：SSE/WS 事件 → StreamBuffer → chatReducer EVENT_BATCH ---

  const refreshSessionUsage = useCallback(async (sessionId: string) => {
    try {
      const usage = await api.sessionUsage(sessionId);
      dispatchChat({
        type: "USAGE_BASELINE",
        totals: usage.totals,
        cacheHitRate: usage.cacheHitRate,
        turns: usage.turns,
        context: usage.context,
      });
    } catch {
      // Server 可能未运行或会话无用量数据
    }
  }, [api]);

  useEffect(() => {
    const buffer = new StreamBuffer((events) => {
      dispatchChat({ type: "EVENT_BATCH", events });
      for (const e of events) {
        if (e.type === "message.completed" || e.type === "session.status") {
          void refreshSessions();
          break;
        }
      }
      for (const e of events) {
        if (e.type === "session.compacted" && e.sessionId !== null) {
          void refreshSessionUsage(e.sessionId);
          break;
        }
      }
    });
    bufferRef.current = buffer;
    return () => buffer.dispose();
  }, [refreshSessionUsage]);

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
      setActiveAgentId(session.agentId ?? null);
      if (session.messageEntries.length > 0) {
        const historyState = buildChatStateFromHistory(session.messageEntries);
        dispatchChat({ type: "LOAD_HISTORY", state: historyState });
      } else {
        dispatchChat({ type: "RESET" });
      }
      void refreshSessionUsage(id);
      if (wsRef.current?.isConnected()) {
        wsRef.current.subscribe(id);
      }
    } catch { /* 会话可能不存在 */ }
  }, [api, refreshSessionUsage]);

  // NewSessionPage 创建会话后由 App 透传 sessionId：在此加载为 activeSession。
  // 路由已由 App 切到 workspace（navigateToWorkspace）；此处只负责会话状态加载。
  useEffect(() => {
    if (!active || createdSessionId === null || createdSessionId === undefined) return;
    const sessionId = createdSessionId;
    void (async () => {
      await handleSelectSession(sessionId);
      navigateToWorkspace();
      onSessionCreatedConsumed?.();
    })();
  }, [active, createdSessionId, handleSelectSession, onSessionCreatedConsumed]);

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
      wsRef.current?.abort(sessionId);
    }
  }, [api, state.activeSessionId, chat.currentStreamId]);

  // --- 会话命令（/help /compact /new /abort /clear）---

  const handleCompactCommand = useCallback(async (): Promise<
    import("../features/chat/commands.js").CommandOutcome
  > => {
    const sessionId = state.activeSessionId;
    if (sessionId === null) {
      return { kind: "card", title: "压缩", lines: ["请先选择会话"], tone: "error" };
    }
    try {
      await api.compact(sessionId);
      return { kind: "none" };
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "SESSION_BUSY") {
        return { kind: "card", title: "压缩失败", lines: ["会话正在生成，无法压缩"], tone: "error" };
      }
      return {
        kind: "card",
        title: "压缩失败",
        lines: [error instanceof Error ? error.message : "压缩请求失败"],
        tone: "error",
      };
    }
  }, [api, state.activeSessionId]);

  const handleNewSessionCommand = useCallback(() => {
    const current = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
    const title = current !== null ? `${current.title}（副本）` : "新会话";
    const cwd = current?.workspaceCwd ?? ".";
    void handleCreateSession(title, cwd);
  }, [state.sessions, state.activeSessionId, handleCreateSession]);

  const handleExecuteCommand = useCallback((name: CommandName) => {
    void executeCommand(name, {
      running: chatRef.current.status === "running",
      onCompact: handleCompactCommand,
      onNewSession: handleNewSessionCommand,
      onAbort: () => void handleAbort(),
    }).then((outcome) => {
      if (outcome.kind === "card") {
        dispatchChat({
          type: "ADD_COMMAND_CARD",
          title: outcome.title,
          lines: outcome.lines,
          ...(outcome.tone !== undefined ? { tone: outcome.tone } : {}),
        });
      }
    });
  }, [handleCompactCommand, handleNewSessionCommand, handleAbort]);

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
      const nullAgentSessions = state.sessions.filter((s) => s.agentId === null);
      if (nullAgentSessions.length > 0) {
        const recent = nullAgentSessions.reduce((a, b) => a.updatedAt > b.updatedAt ? a : b);
        await handleSelectSession(recent.id);
      } else {
        dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
        dispatchChat({ type: "RESET" });
      }
      return;
    }
    try {
      const agentSessions = await api.getAgentSessions(agentId);
      if (agentSessions.length > 0) {
        const recent = agentSessions.reduce((a, b) => a.updatedAt > b.updatedAt ? a : b);
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

  // 时间线显隐切换（持久化到偏好）
  const handleToggleTimeline = useCallback(() => {
    const next = !timelineVisible;
    setTimelineVisible(next);
    api.updatePreferences({ appearance: { timelineVisible: next } }).catch(() => {});
  }, [timelineVisible, api]);

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;

  // ─── Phase 14 Subagent：卡片列表 + 右侧只读面板 ─────────────────

  // §22.1 归属 = 父 Agent（无 Agent 时回退 Session）+ 父 Session
  const subagentOwnership = activeSession !== null
    ? { ownerAgentId: activeSession.agentId ?? activeSession.id, parentSessionId: activeSession.id }
    : null;
  const subagentsOnline = active && state.connectionStatus === "online";
  const subagentThreads = useSubagentThreads({
    api,
    ownership: subagentOwnership,
    enabled: subagentsOnline && activeSession !== null,
    openPanelThreadId: selectedSubagentThreadId,
  });

  // 切换主对话后关闭面板（不显示旧 Session Thread，§21.2）
  useEffect(() => {
    setSelectedSubagentThreadId(null);
  }, [state.activeSessionId]);

  const handleOpenSubagent = useCallback((threadId: SubagentThreadId) => {
    setSelectedSubagentThreadId(threadId);
    // 右侧栏收起时展开（窄屏打开抽屉）
    if (layout.rightCollapsed) layout.handleToggleRight();
  }, [layout.rightCollapsed, layout.handleToggleRight]);

  const handleCloseSubagent = useCallback(() => {
    setSelectedSubagentThreadId(null);
  }, []);

  // §21.1 只读请求按钮：向主对话发结构化消息，不直接控制 Subagent
  const handleRequestParentAction = useCallback((
    threadId: SubagentThreadId,
    action: SubagentParentRequestAction,
    title: string,
  ) => {
    if (state.activeSessionId === null) return;
    const text = action === "cancel"
      ? `【Subagent 请求】请主 Agent 取消 Subagent「${title}」（${threadId}）。`
      : `【Subagent 请求】请主 Agent 为 Subagent「${title}」（${threadId}）补充信息：`;
    void handleSend(text);
  }, [state.activeSessionId, handleSend]);

  return (
    <AppShell
      layout={layout}
      active={active}
      titlebar={
        <ServerStatusBar
          status={state.supervisorStatus}
          connectionStatus={state.connectionStatus}
          onStart={handleStart}
          onStop={handleStop}
          onRestart={handleRestart}
          onToggleLeft={layout.handleToggleLeft}
          onToggleRight={layout.handleToggleRight}
          leftCollapsed={layout.leftCollapsed}
          rightCollapsed={layout.rightCollapsed}
        />
      }
      left={
        <SessionSidebar
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          collapsed={layout.leftCollapsed}
          onSelect={(id) => void handleSelectSession(id)}
          onArchive={(id) => void handleArchiveSession(id)}
          onUnarchive={(id) => void handleUnarchiveSession(id)}
          onToggle={layout.handleToggleLeft}
          agents={agents}
          activeAgentId={activeAgentId}
          onSelectAgent={(id) => void handleSelectAgent(id)}
        />
      }
      center={
        <ChatPane
          session={activeSession}
          chat={chat}
          models={state.models}
          onSend={(content) => void handleSend(content)}
          onAbort={() => void handleAbort()}
          onExecuteCommand={handleExecuteCommand}
          onToggleThinking={(id) => dispatchChat({ type: "TOGGLE_THINKING", id })}
          onSelectModel={(providerId, modelId) => void handleSelectModel(providerId, modelId)}
          onToolModeChange={(mode) => void handleToolModeChange(mode)}
          onThinkingLevelChange={(level) => void handleThinkingLevelChange(level)}
          sseConnected={sseConnected && state.connectionStatus === "online"}
          onSettingsClick={onSettingsClick}
          reducedMotion={layout.reducedMotion}
          showThinking={showThinking}
          showToolCalls={showToolCalls}
          timelineVisible={timelineVisible}
          onToggleTimeline={handleToggleTimeline}
          narrowScreen={layout.breakpoints.rightNarrow}
          subagentCards={subagentThreads.cards}
          onOpenSubagent={(threadId) => handleOpenSubagent(threadId)}
          onRequestParentAction={(threadId, action, title) => handleRequestParentAction(threadId, action, title)}
        />
      }
      right={
        <InspectorSidebar
          collapsed={layout.rightCollapsed}
          onToggle={layout.handleToggleRight}
          panel={
            selectedSubagentThreadId !== null && activeSession !== null && subagentOwnership !== null
              ? (
                  <SubagentPanel
                    threadId={selectedSubagentThreadId}
                    ownership={subagentOwnership}
                    api={api}
                    enabled={subagentsOnline}
                    mobile={layout.breakpoints.rightNarrow}
                    reducedMotion={layout.reducedMotion}
                    onClose={handleCloseSubagent}
                  />
                )
              : undefined
          }
        />
      }
    />
  );
}
