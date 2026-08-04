import { useEffect, useState } from "react";

export type PageRoute = "workspace" | "settings" | "plugins" | "memory" | "session-new" | "agent-new" | "agent-edit" | "logs";

interface AgentFormHistoryState extends Record<string, unknown> {
  readonly __agentFormEntry?: boolean;
  readonly __agentFormDirty?: boolean;
  readonly __agentFormDirect?: boolean;
}

export type AgentFormExitAction =
  | { readonly kind: "replace" }
  | { readonly kind: "go" | "go-and-replace"; readonly delta: -1 | -2 };

function historyState(value: unknown): AgentFormHistoryState {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AgentFormHistoryState
    : {};
}

export function resolveAgentFormExit(value: unknown): AgentFormExitAction {
  const state = historyState(value);
  if (state.__agentFormDirect === true) {
    return state.__agentFormDirty === true
      ? { kind: "go-and-replace", delta: -1 }
      : { kind: "replace" };
  }
  if (state.__agentFormEntry === true) {
    return { kind: "go", delta: state.__agentFormDirty === true ? -2 : -1 };
  }
  return { kind: "replace" };
}

/**
 * 把 pathname 解析为页面路由。语义：
 * - `/` 或空 → workspace
 * - 以 `/settings` 开头（忽略末尾的 query/hash） → settings
 * - `/new` 或 `/new/...` → session-new（独立新建会话单页）
 * - 其它 → workspace（设置中心从顶部按钮进入，未知深链一律回工作台）
 */
export function routeFromPathname(pathname: string): PageRoute {
  const clean = pathname.split("#")[0]?.split("?")[0];
  if (clean === undefined || clean === "" || clean === "/") return "workspace";
  if (clean === "/settings" || clean.startsWith("/settings/")) return "settings";
  if (clean === "/memory" || clean.startsWith("/memory/")) return "memory";
  if (clean === "/logs" || clean.startsWith("/logs/")) return "logs";
  if (clean === "/plugins" || clean.startsWith("/plugins/")) return "plugins";
  if (clean === "/new" || clean.startsWith("/new/")) return "session-new";
  if (clean === "/agents/new" || clean.startsWith("/agents/new/")) return "agent-new";
  if (clean.startsWith("/agents/")) return "agent-edit";
  return "workspace";
}

/**
 * 订阅 `popstate` 与 `history.pushState/replaceState`，返回当前页面路由。
 * 不引入路由依赖；设置页跳转通过 `navigateToSettings` 触发 `pushState`。
 */
export function usePageRoute(): PageRoute {
  const [route, setRoute] = useState<PageRoute>(() =>
    typeof window === "undefined" ? "workspace" : routeFromPathname(window.location.pathname),
  );

  useEffect(() => {
    const sync = () => setRoute(routeFromPathname(window.location.pathname));
    window.addEventListener("popstate", sync);
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    history.pushState = function patchedPushState(...args: Parameters<typeof pushState>) {
      const result = pushState(...args);
      sync();
      return result;
    };
    history.replaceState = function patchedReplaceState(...args: Parameters<typeof replaceState>) {
      const result = replaceState(...args);
      sync();
      return result;
    };
    return () => {
      window.removeEventListener("popstate", sync);
      history.pushState = pushState;
      history.replaceState = replaceState;
    };
  }, []);

  return route;
}

export function navigateToSettings(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/settings");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToLogs(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/logs");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToPlugins(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/plugins");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToPluginDetail(pluginId: string): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", `/plugins/${encodeURIComponent(pluginId)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToMemory(agentId?: string): void {
  if (typeof window === "undefined") return;
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
  history.pushState({}, "", `/memory${query}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToWorkspace(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToNewSession(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/new");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToAgentNew(): void {
  if (typeof window === "undefined") return;
  history.pushState({ __agentFormEntry: true }, "", "/agents/new");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToAgentEdit(agentId: string): void {
  if (typeof window === "undefined") return;
  history.pushState({ __agentFormEntry: true }, "", `/agents/${agentId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function initializeAgentFormHistory(): void {
  if (typeof window === "undefined") return;
  const state = historyState(history.state);
  if (state.__agentFormEntry === true) return;
  history.replaceState(
    { ...state, __agentFormEntry: true, __agentFormDirect: true },
    "",
    window.location.href,
  );
}

export function pushAgentFormDirtyHistory(): void {
  if (typeof window === "undefined") return;
  const state = historyState(history.state);
  if (state.__agentFormDirty === true) return;
  history.pushState(
    { ...state, __agentFormEntry: true, __agentFormDirty: true },
    "",
    window.location.href,
  );
}

export function leaveAgentFormForSettings(section: string): void {
  if (typeof window === "undefined") return;
  const target = `/settings?section=${section}`;
  const replaceWithTarget = () => {
    history.replaceState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const action = resolveAgentFormExit(history.state);
  if (action.kind === "replace") {
    replaceWithTarget();
    return;
  }
  window.addEventListener("popstate", replaceWithTarget, { once: true });
  history.go(action.delta);
}

export function navigateToSettingsSection(section: string): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", `/settings?section=${section}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
