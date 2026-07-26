import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client.js";
import type { AppearancePreferences, LayoutPreferences } from "../../lib/types.js";
import type { AppAction, SidebarState } from "../../app/state.js";
import { usePanelResize } from "./use-panel-resize.js";
import {
  mergeLayoutPreferences,
  DEFAULT_LAYOUT_ONLY,
  getSidebarPresentation,
  isDrawerBackdropOpen,
  resolveReducedMotion,
  withSidebarCollapsed,
} from "./layout-preferences.js";

/** 窄屏断点：左栏 ≤768px 转抽屉，右栏 ≤1024px 转抽屉。 */
export const NARROW_LEFT_QUERY = "(max-width: 768px)";
export const NARROW_RIGHT_QUERY = "(max-width: 1024px)";

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
}

function applyLayoutVars(layout: LayoutPreferences, reducedMotion: boolean): void {
  document.documentElement.style.setProperty("--left-sidebar-width", `${layout.leftSidebarWidth}px`);
  document.documentElement.style.setProperty("--right-sidebar-width", `${layout.rightSidebarWidth}px`);
  document.documentElement.style.setProperty(
    "--transition-duration",
    reducedMotion ? "0ms" : "0.2s",
  );
}

export interface LayoutStateResult {
  /** 最近加载的偏好（含 layout + appearance 字段，供调用方读取 showThinking 等）。 */
  readonly preferences: LayoutPreferences;
  readonly breakpoints: { readonly leftNarrow: boolean; readonly rightNarrow: boolean };
  readonly reducedMotion: boolean;
  readonly viewportWidth: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly focusMode: boolean;
  readonly drawerOpen: boolean;
  readonly leftResizeRef: React.RefObject<HTMLDivElement | null>;
  readonly rightResizeRef: React.RefObject<HTMLDivElement | null>;
  readonly leftResize: ReturnType<typeof usePanelResize>;
  readonly rightResize: ReturnType<typeof usePanelResize>;
  readonly handleToggleLeft: () => void;
  readonly handleToggleRight: () => void;
  readonly closeDrawers: () => void;
}

export interface UseLayoutStateOptions {
  readonly active: boolean;
  readonly api: ApiClient;
  /** 仅用于派发侧栏开关（SET_LEFT_SIDEBAR / SET_RIGHT_SIDEBAR）。 */
  readonly dispatchSidebar: (action: AppAction) => void;
  /** 当前侧栏状态（来自 appReducer），用于派生 collapsed / focusMode / 互斥抽屉。 */
  readonly leftSidebar: SidebarState;
  readonly rightSidebar: SidebarState;
  /** 偏好加载完成时回调，调用方可读取 appearance 字段（showThinking / theme 等）。 */
  readonly onPreferencesLoaded?: (appearance: AppearancePreferences) => void;
}

/**
 * 布局状态 hook —— 封装断点 / reducedMotion / viewport / 侧栏开关 / 主题 /
 * `--left/right-sidebar-width` 与 `--transition-duration` CSS 变量应用 / 拖拽 resize。
 *
 * 不持有业务数据（会话/Provider/SSE/WS 由调用方管理）。侧栏的 collapsed 状态仍存于
 * appReducer（调用方传入 leftSidebar/rightSidebar），本 hook 负责派生 focusMode、
 * drawerOpen、互斥抽屉、resize 边界与持久化。
 */
export function useLayoutState(options: UseLayoutStateOptions): LayoutStateResult {
  const { active, api, dispatchSidebar, leftSidebar, rightSidebar, onPreferencesLoaded } = options;

  const [layoutPrefs, setLayoutPrefs] = useState<LayoutPreferences>(DEFAULT_LAYOUT_ONLY);
  const [breakpoints, setBreakpoints] = useState(() => ({
    leftNarrow:
      typeof window !== "undefined" && window.matchMedia(NARROW_LEFT_QUERY).matches,
    rightNarrow:
      typeof window !== "undefined" && window.matchMedia(NARROW_RIGHT_QUERY).matches,
  }));
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );

  const leftResizeRef = useRef<HTMLDivElement | null>(null);
  const rightResizeRef = useRef<HTMLDivElement | null>(null);

  const onPreferencesLoadedRef = useRef(onPreferencesLoaded);
  onPreferencesLoadedRef.current = onPreferencesLoaded;

  // 偏好加载：layout + appearance（theme/showThinking 等交回调给调用方）
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    api.getPreferences().then((prefs) => {
      if (cancelled) return;
      const layout = mergeLayoutPreferences(prefs.layout, DEFAULT_LAYOUT_ONLY);
      setLayoutPrefs(layout);
      applyTheme(prefs.appearance.theme);
      onPreferencesLoadedRef.current?.(prefs.appearance);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, api]);

  // 断点 / reducedMotion / viewport 监听
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

  // 应用 CSS 变量 + 同步侧栏状态到 appReducer（断点/偏好变化时收起窄屏侧栏）
  useEffect(() => {
    applyLayoutVars(layoutPrefs, reducedMotion);
    const presentation = getSidebarPresentation(layoutPrefs, breakpoints);
    dispatchSidebar({
      type: "SET_LEFT_SIDEBAR",
      payload: presentation.leftCollapsed ? "collapsed" : "expanded",
    });
    dispatchSidebar({
      type: "SET_RIGHT_SIDEBAR",
      payload: presentation.rightCollapsed ? "collapsed" : "expanded",
    });
  }, [layoutPrefs, breakpoints, reducedMotion, dispatchSidebar]);

  const leftCollapsed = leftSidebar === "collapsed";
  const rightCollapsed = rightSidebar === "collapsed";
  const focusMode = leftCollapsed && rightCollapsed;
  const drawerOpen = isDrawerBackdropOpen(breakpoints, { leftCollapsed, rightCollapsed });

  // 拖拽 resize 边界（依赖两侧 collapsed 与 viewport，避免互相遮挡）
  const leftMaxWidth = Math.max(
    200,
    Math.min(420, viewportWidth - (rightCollapsed ? 0 : layoutPrefs.rightSidebarWidth) - 430),
  );
  const rightMaxWidth = Math.max(
    240,
    Math.min(520, viewportWidth - (leftCollapsed ? 0 : layoutPrefs.leftSidebarWidth) - 430),
  );

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

  // 窄屏一次只开一个抽屉：打开一侧时收起另一侧（互斥）
  const handleToggleLeft = useCallback(() => {
    const opening = leftSidebar === "collapsed";
    const nextCollapsed = !leftCollapsed;
    dispatchSidebar({
      type: "SET_LEFT_SIDEBAR",
      payload: nextCollapsed ? "collapsed" : "expanded",
    });
    if (!breakpoints.leftNarrow) {
      const nextLayout = withSidebarCollapsed(layoutPrefs, "left", nextCollapsed);
      setLayoutPrefs(nextLayout);
      api.updatePreferences({
        layout: { leftCollapsed: nextLayout.leftCollapsed, focusMode: nextLayout.focusMode },
      }).catch(() => {});
    }
    if (opening && breakpoints.leftNarrow && rightSidebar === "expanded") {
      dispatchSidebar({ type: "SET_RIGHT_SIDEBAR", payload: "collapsed" });
    }
  }, [leftSidebar, rightSidebar, leftCollapsed, breakpoints.leftNarrow, api, layoutPrefs, dispatchSidebar]);

  const handleToggleRight = useCallback(() => {
    const opening = rightSidebar === "collapsed";
    const nextCollapsed = !rightCollapsed;
    dispatchSidebar({
      type: "SET_RIGHT_SIDEBAR",
      payload: nextCollapsed ? "collapsed" : "expanded",
    });
    if (!breakpoints.rightNarrow) {
      const nextLayout = withSidebarCollapsed(layoutPrefs, "right", nextCollapsed);
      setLayoutPrefs(nextLayout);
      api.updatePreferences({
        layout: { rightCollapsed: nextLayout.rightCollapsed, focusMode: nextLayout.focusMode },
      }).catch(() => {});
    }
    if (opening && breakpoints.leftNarrow && leftSidebar === "expanded") {
      dispatchSidebar({ type: "SET_LEFT_SIDEBAR", payload: "collapsed" });
    }
  }, [leftSidebar, rightSidebar, rightCollapsed, breakpoints, api, layoutPrefs, dispatchSidebar]);

  const closeDrawers = useCallback(() => {
    if (breakpoints.leftNarrow && leftSidebar === "expanded") {
      dispatchSidebar({ type: "SET_LEFT_SIDEBAR", payload: "collapsed" });
    }
    if (breakpoints.rightNarrow && rightSidebar === "expanded") {
      dispatchSidebar({ type: "SET_RIGHT_SIDEBAR", payload: "collapsed" });
    }
  }, [breakpoints, leftSidebar, rightSidebar, dispatchSidebar]);

  return {
    preferences: layoutPrefs,
    breakpoints,
    reducedMotion,
    viewportWidth,
    leftCollapsed,
    rightCollapsed,
    focusMode,
    drawerOpen,
    leftResizeRef,
    rightResizeRef,
    leftResize,
    rightResize,
    handleToggleLeft,
    handleToggleRight,
    closeDrawers,
  };
}
