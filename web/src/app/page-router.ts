import { useEffect, useState } from "react";

export type PageRoute = "workspace" | "settings";

/**
 * 把 pathname 解析为页面路由。语义：
 * - `/` 或空 → workspace
 * - 以 `/settings` 开头（忽略末尾的 query/hash） → settings
 * - 其它 → workspace（设置中心从顶部按钮进入，未知深链一律回工作台）
 */
export function routeFromPathname(pathname: string): PageRoute {
  const clean = pathname.split("#")[0]?.split("?")[0];
  if (clean === undefined || clean === "" || clean === "/") return "workspace";
  if (clean === "/settings" || clean.startsWith("/settings/")) return "settings";
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

export function navigateToWorkspace(): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}