import { describe, expect, it } from "vitest";

import { appReducer, initialAppState, type AppAction } from "./state.js";

describe("appReducer", () => {
  it("starts with initial state", () => {
    expect(initialAppState.connectionStatus).toBe("connecting");
    expect(initialAppState.leftSidebar).toBe("expanded");
    expect(initialAppState.rightSidebar).toBe("expanded");
    expect(initialAppState.sessions).toEqual([]);
    expect(initialAppState.activeSessionId).toBeNull();
  });

  it("sets supervisor status and derives connection status", () => {
    const action: AppAction = {
      type: "SET_SUPERVISOR_STATUS",
      payload: {
        status: "online",
        supervisor: { pid: 1, port: 4311, version: "0.1.0", uptimeSeconds: 10 },
        agentServer: { status: "online", pid: 2, port: 4310, version: "0.1.0" },
      },
    };
    const state = appReducer(initialAppState, action);
    expect(state.connectionStatus).toBe("online");
    expect(state.supervisorStatus?.agentServer.port).toBe(4310);
  });

  it("maps stopped agent server to stopped connection", () => {
    const action: AppAction = {
      type: "SET_SUPERVISOR_STATUS",
      payload: {
        status: "stopped",
        supervisor: { pid: 1, port: 4311, version: "0.1.0", uptimeSeconds: 10 },
        agentServer: { status: "stopped", pid: null, port: null, version: null },
      },
    };
    const state = appReducer(initialAppState, action);
    expect(state.connectionStatus).toBe("stopped");
  });

  it("maps error agent server to error connection", () => {
    const action: AppAction = {
      type: "SET_SUPERVISOR_STATUS",
      payload: {
        status: "error",
        supervisor: { pid: 1, port: 4311, version: "0.1.0", uptimeSeconds: 10 },
        agentServer: { status: "error", pid: null, port: null, version: null },
      },
    };
    const state = appReducer(initialAppState, action);
    expect(state.connectionStatus).toBe("error");
  });

  it("toggles left sidebar independently", () => {
    let state = appReducer(initialAppState, { type: "TOGGLE_LEFT_SIDEBAR" });
    expect(state.leftSidebar).toBe("collapsed");
    expect(state.rightSidebar).toBe("expanded");

    state = appReducer(state, { type: "TOGGLE_LEFT_SIDEBAR" });
    expect(state.leftSidebar).toBe("expanded");
  });

  it("toggles right sidebar independently", () => {
    let state = appReducer(initialAppState, { type: "TOGGLE_RIGHT_SIDEBAR" });
    expect(state.rightSidebar).toBe("collapsed");
    expect(state.leftSidebar).toBe("expanded");

    state = appReducer(state, { type: "TOGGLE_RIGHT_SIDEBAR" });
    expect(state.rightSidebar).toBe("expanded");
  });

  it("both sidebars can be collapsed for chat-first mode", () => {
    let state = appReducer(initialAppState, { type: "TOGGLE_LEFT_SIDEBAR" });
    state = appReducer(state, { type: "TOGGLE_RIGHT_SIDEBAR" });
    expect(state.leftSidebar).toBe("collapsed");
    expect(state.rightSidebar).toBe("collapsed");
  });

  it("sets sessions and active session", () => {
    const sessions = [
      {
        id: "s1",
        title: "Test",
        sessionPath: "/tmp/s1",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        archived: false,
        toolMode: "read-only",
        workspaceCwd: "/tmp",
        workspaceConfirmed: false,
        thinkingLevel: "medium",
        messages: [],
        messageEntries: [],
        model: null,
      },
    ];
    let state = appReducer(initialAppState, { type: "SET_SESSIONS", payload: sessions });
    expect(state.sessions).toHaveLength(1);

    state = appReducer(state, { type: "SET_ACTIVE_SESSION", payload: "s1" });
    expect(state.activeSessionId).toBe("s1");
  });

  it("sets error state", () => {
    const state = appReducer(initialAppState, { type: "SET_ERROR", payload: "连接失败" });
    expect(state.error).toBe("连接失败");
  });

  it("sets loading state", () => {
    const state = appReducer(initialAppState, { type: "SET_LOADING", payload: true });
    expect(state.loading).toBe(true);
  });
});
