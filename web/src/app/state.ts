import type { SessionView, SupervisorStatusResponse } from "../lib/types.js";

export type SidebarState = "expanded" | "collapsed";

export type ConnectionStatus = "connecting" | "online" | "stopped" | "error";

export interface AppState {
  readonly supervisorStatus: SupervisorStatusResponse | null;
  readonly connectionStatus: ConnectionStatus;
  readonly sessions: SessionView[];
  readonly activeSessionId: string | null;
  readonly leftSidebar: SidebarState;
  readonly rightSidebar: SidebarState;
  readonly loading: boolean;
  readonly error: string | null;
}

export const initialAppState: AppState = {
  supervisorStatus: null,
  connectionStatus: "connecting",
  sessions: [],
  activeSessionId: null,
  leftSidebar: "expanded",
  rightSidebar: "expanded",
  loading: false,
  error: null,
};

export type AppAction =
  | { type: "SET_SUPERVISOR_STATUS"; payload: SupervisorStatusResponse }
  | { type: "SET_CONNECTION_STATUS"; payload: ConnectionStatus }
  | { type: "SET_SESSIONS"; payload: SessionView[] }
  | { type: "SET_ACTIVE_SESSION"; payload: string | null }
  | { type: "TOGGLE_LEFT_SIDEBAR" }
  | { type: "TOGGLE_RIGHT_SIDEBAR" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_ERROR"; payload: string | null };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_SUPERVISOR_STATUS":
      return {
        ...state,
        supervisorStatus: action.payload,
        connectionStatus: action.payload.agentServer.status === "online" ? "online" : action.payload.agentServer.status === "stopped" ? "stopped" : "error",
      };
    case "SET_CONNECTION_STATUS":
      return { ...state, connectionStatus: action.payload };
    case "SET_SESSIONS":
      return { ...state, sessions: action.payload };
    case "SET_ACTIVE_SESSION":
      return { ...state, activeSessionId: action.payload };
    case "TOGGLE_LEFT_SIDEBAR":
      return { ...state, leftSidebar: state.leftSidebar === "expanded" ? "collapsed" : "expanded" };
    case "TOGGLE_RIGHT_SIDEBAR":
      return { ...state, rightSidebar: state.rightSidebar === "expanded" ? "collapsed" : "expanded" };
    case "SET_LOADING":
      return { ...state, loading: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
  }
}
