import { useCallback, useEffect, useReducer, useRef } from "react";

import { ApiClient } from "../lib/api-client.js";
import { SseClient } from "../lib/sse-client.js";
import { appReducer, initialAppState } from "./state.js";
import { ServerStatusBar } from "../components/ServerStatusBar.jsx";
import { SessionSidebar } from "../components/SessionSidebar.jsx";
import { ChatPane } from "../components/ChatPane.jsx";
import { InspectorSidebar } from "../components/InspectorSidebar.jsx";
import "./layout.css";

const API_BASE = "";

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const apiRef = useRef(new ApiClient(API_BASE));
  const sseRef = useRef<SseClient | null>(null);
  const api = apiRef.current;

  const refreshSupervisorStatus = useCallback(async () => {
    try {
      const status = await api.getSupervisorStatus();
      dispatch({ type: "SET_SUPERVISOR_STATUS", payload: status });
    } catch {
      dispatch({ type: "SET_CONNECTION_STATUS", payload: "error" });
    }
  }, [api]);

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await api.listSessions();
      dispatch({ type: "SET_SESSIONS", payload: sessions });
    } catch {
      // Server may not be running
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
    }
  }, [state.connectionStatus, refreshSessions]);

  // SSE connection for active session
  useEffect(() => {
    if (state.activeSessionId && state.connectionStatus === "online") {
      sseRef.current?.dispose();
      const sse = new SseClient({
        baseUrl: API_BASE,
        sessionId: state.activeSessionId,
        onEvent: () => {
          // Refresh sessions to get latest messages
          void refreshSessions();
        },
      });
      sse.connect();
      sseRef.current = sse;
      return () => sse.dispose();
    }
    return undefined;
  }, [state.activeSessionId, state.connectionStatus, refreshSessions]);

  const handleStart = useCallback(async () => {
    try {
      await api.startAgentServer();
      await refreshSupervisorStatus();
    } catch { /* handled by status refresh */ }
  }, [api, refreshSupervisorStatus]);

  const handleStop = useCallback(async () => {
    try {
      await api.stopAgentServer();
      await refreshSupervisorStatus();
    } catch { /* handled by status refresh */ }
  }, [api, refreshSupervisorStatus]);

  const handleRestart = useCallback(async () => {
    try {
      await api.restartAgentServer();
      await refreshSupervisorStatus();
    } catch { /* handled by status refresh */ }
  }, [api, refreshSupervisorStatus]);

  const handleCreateSession = useCallback(async () => {
    try {
      const session = await api.createSession("新会话", process.cwd?.() ?? ".");
      dispatch({ type: "SET_ACTIVE_SESSION", payload: session.id });
      await refreshSessions();
    } catch { /* handled by status refresh */ }
  }, [api, refreshSessions]);

  const handleSend = useCallback(async (content: string) => {
    if (!state.activeSessionId) return;
    try {
      await api.sendPrompt(state.activeSessionId, content);
    } catch { /* handled by status refresh */ }
  }, [api, state.activeSessionId]);

  const handleAbort = useCallback(async () => {
    if (!state.activeSessionId) return;
    try {
      // We need the current streamId — for now use abort by session
      const session = state.sessions.find((s) => s.id === state.activeSessionId);
      if (session) {
        // Abort via API — streamId would come from the active prompt
        // For the skeleton, just log
      }
    } catch { /* ignore */ }
  }, [api, state.activeSessionId, state.sessions]);

  const handleCompact = useCallback(async () => {
    if (!state.activeSessionId) return;
    try {
      await api.compact(state.activeSessionId);
    } catch { /* ignore */ }
  }, [api, state.activeSessionId]);

  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const leftCollapsed = state.leftSidebar === "collapsed";
  const rightCollapsed = state.rightSidebar === "collapsed";

  return (
    <div className="app-layout">
      <ServerStatusBar
        status={state.supervisorStatus}
        connectionStatus={state.connectionStatus}
        onStart={handleStart}
        onStop={handleStop}
        onRestart={handleRestart}
        onToggleLeft={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
        onToggleRight={() => dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" })}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
      />
      <div className="app-main">
        <SessionSidebar
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          collapsed={leftCollapsed}
          onSelect={(id) => dispatch({ type: "SET_ACTIVE_SESSION", payload: id })}
          onCreate={handleCreateSession}
          onToggle={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
        />
        <ChatPane
          session={activeSession}
          onSend={handleSend}
          onAbort={handleAbort}
          onCompact={handleCompact}
          sending={false}
        />
        <InspectorSidebar
          session={activeSession}
          collapsed={rightCollapsed}
          onToggle={() => dispatch({ type: "TOGGLE_RIGHT_SIDEBAR" })}
        />
      </div>
    </div>
  );
}
