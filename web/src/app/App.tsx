import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiClient } from "../lib/api-client.js";
import { SseClient } from "../lib/sse-client.js";
import { WsClient } from "../lib/ws-client.js";
import type { PlatformEventEnvelope } from "../lib/types.js";
import { appReducer, initialAppState } from "./state.js";
import { chatReducer, initialChatState, getStreamCursor } from "../features/chat/chat-state.js";
import { ServerStatusBar } from "../components/ServerStatusBar.jsx";
import { SessionSidebar } from "../components/SessionSidebar.jsx";
import { ChatPane } from "../components/ChatPane.jsx";
import { InspectorSidebar } from "../components/InspectorSidebar.jsx";
import type { ProviderFormData } from "../features/providers/provider-form.js";
import "./layout.css";

// 同源部署：Supervisor 托管 Web 并代理 Agent API
const API_BASE = "";

const NARROW_LEFT_QUERY = "(max-width: 768px)";
const NARROW_RIGHT_QUERY = "(max-width: 1024px)";

export function App() {
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialAppState,
    // 窄屏默认收起侧栏，避免首屏抽屉互相覆盖
    leftSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches ? "collapsed" as const : "expanded" as const,
    rightSidebar: typeof window !== "undefined" && window.matchMedia(NARROW_RIGHT_QUERY).matches ? "collapsed" as const : "expanded" as const,
  }));
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const [sseConnected, setSseConnected] = useState(false);
  const apiRef = useRef(new ApiClient(API_BASE));
  const sseRef = useRef<SseClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const api = apiRef.current;

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

  useEffect(() => {
    void refreshSupervisorStatus();
    const interval = setInterval(() => void refreshSupervisorStatus(), 5_000);
    return () => clearInterval(interval);
  }, [refreshSupervisorStatus]);

  useEffect(() => {
    if (state.connectionStatus === "online") {
      void refreshSessions();
      void refreshProvidersAndModels();
      // Agent 在线期间定期刷新模型与 Provider（Provider 可能在运行中被配置）
      const interval = setInterval(() => {
        void refreshProvidersAndModels();
      }, 10_000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [state.connectionStatus, refreshSessions, refreshProvidersAndModels]);

  // --- 事件流接线：SSE 事件 → chat reducer ---

  const handlePlatformEvent = useCallback((event: PlatformEventEnvelope) => {
    dispatchChat({ type: "EVENT", event });
    // message.completed 后刷新会话历史
    if (event.type === "message.completed" || event.type === "session.status") {
      void refreshSessions();
    }
  }, [refreshSessions]);

  useEffect(() => {
    if (state.activeSessionId && state.connectionStatus === "online") {
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
  }, [state.activeSessionId, state.connectionStatus, handlePlatformEvent, refreshSessions]);

  // --- 会话操作 ---

  const handleSelectSession = useCallback(async (id: string) => {
    dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
    dispatchChat({ type: "RESET" });
    try {
      const session = await api.getSession(id);
      dispatch({ type: "UPSERT_SESSION", payload: session });
      // WS 订阅该会话
      if (wsRef.current?.isConnected()) {
        wsRef.current.subscribe(id);
      }
    } catch { /* 会话可能不存在 */ }
  }, [api]);

  const handleCreateSession = useCallback(async (title: string, cwd: string) => {
    try {
      const session = await api.createSession(title, cwd);
      dispatch({ type: "UPSERT_SESSION", payload: session });
      dispatch({ type: "SET_ACTIVE_SESSION", payload: session.id });
      dispatchChat({ type: "RESET" });
    } catch (error) {
      dispatch({ type: "SET_ERROR", payload: error instanceof Error ? error.message : "创建会话失败" });
    }
  }, [api]);

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

  const handleCompact = useCallback(async () => {
    if (!state.activeSessionId) return;
    const sessionId = state.activeSessionId;
    try {
      await api.compact(sessionId);
    } catch {
      wsRef.current?.compact(sessionId);
    }
  }, [api, state.activeSessionId]);

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

  const handleSaveProvider = useCallback(async (data: ProviderFormData) => {
    await api.updateProvider(
      {
        providerId: data.providerId,
        name: data.name,
        protocol: data.protocol,
        baseUrl: data.baseUrl,
        models: [{
          modelId: data.modelId,
          name: data.modelName || data.modelId,
          capabilities: {
            reasoning: data.reasoning,
            input: ["text"],
            contextWindow: data.contextWindow,
            maxTokens: data.maxTokens,
          },
        }],
      },
      data.apiKey || undefined,
    );
    await refreshProvidersAndModels();
  }, [api, refreshProvidersAndModels]);

  const handleSaveSessionSettings = useCallback(async (settings: Record<string, unknown>) => {
    if (!state.activeSessionId) return;
    const session = await api.updateSessionSettings(state.activeSessionId, settings);
    dispatch({ type: "UPSERT_SESSION", payload: session });
  }, [api, state.activeSessionId]);

  const handleShowLogs = useCallback(async () => {
    try {
      const { logs } = await api.getSupervisorLogs();
      const container = document.getElementById("supervisor-logs");
      if (container) container.textContent = logs || "暂无日志";
    } catch { /* 忽略 */ }
  }, [api]);

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
  const narrowLayout = typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches;
  const drawerOpen = narrowLayout && (!leftCollapsed || !rightCollapsed);

  // 窄屏一次只打开一个抽屉：打开一侧时收起另一侧
  const handleToggleLeft = useCallback(() => {
    const opening = state.leftSidebar === "collapsed";
    dispatch({ type: "TOGGLE_LEFT_SIDEBAR" });
    if (opening && window.matchMedia(NARROW_LEFT_QUERY).matches && state.rightSidebar === "expanded") {
      dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" });
    }
  }, [state.leftSidebar, state.rightSidebar]);

  const handleToggleRight = useCallback(() => {
    const opening = state.rightSidebar === "collapsed";
    dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" });
    if (opening && window.matchMedia(NARROW_LEFT_QUERY).matches && state.leftSidebar === "expanded") {
      dispatch({ type: "TOGGLE_LEFT_SIDEBAR" });
    }
  }, [state.leftSidebar, state.rightSidebar]);

  const closeDrawers = useCallback(() => {
    if (state.leftSidebar === "expanded") dispatch({ type: "TOGGLE_LEFT_SIDEBAR" });
    if (state.rightSidebar === "expanded") dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" });
  }, [state.leftSidebar, state.rightSidebar]);

  return (
    <div className="app-layout">
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
        />
        <ChatPane
          session={activeSession}
          chat={chat}
          models={state.models}
          onSend={(content) => void handleSend(content)}
          onAbort={() => void handleAbort()}
          onCompact={() => void handleCompact()}
          onToggleThinking={() => dispatchChat({ type: "TOGGLE_THINKING" })}
          onSelectModel={(providerId, modelId) => void handleSelectModel(providerId, modelId)}
          sseConnected={sseConnected && state.connectionStatus === "online"}
        />
        <InspectorSidebar
          session={activeSession}
          providers={state.providers}
          collapsed={rightCollapsed}
          saving={state.loading}
          onToggle={handleToggleRight}
          onSaveProvider={handleSaveProvider}
          onSaveSessionSettings={handleSaveSessionSettings}
          onShowLogs={() => void handleShowLogs()}
        />
      </div>
    </div>
  );
}
