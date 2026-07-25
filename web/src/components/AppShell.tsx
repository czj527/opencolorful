import { useEffect, type ReactNode } from "react";
import type { LayoutStateResult } from "../features/layout/useLayoutState.js";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  /** 来自 useLayoutState 的布局状态（侧栏开关/宽度/窄屏/focus/drawer/resize）。 */
  readonly layout: LayoutStateResult;
  /** 工作台是否处于活动路由（驱动 data-workspace-active）。 */
  readonly active: boolean;
  /** 顶部状态栏（ServerStatusBar）。 */
  readonly titlebar: ReactNode;
  /** 左侧栏内容（SessionSidebar）。 */
  readonly left: ReactNode;
  /** 中央聊天区内容（ChatPane）。 */
  readonly center: ReactNode;
  /** 右侧栏内容（InspectorSidebar）。 */
  readonly right: ReactNode;
}

const rootClass = styles.root ?? "";
const mainClass = styles.main ?? "";
const backdropClass = styles.backdrop ?? "";
const resizeClass = styles.resize ?? "";

/**
 * 纯布局壳：接收布局状态与三个面板内容，组合三栏响应布局。
 * 不持有业务数据；侧栏开关 / 拖拽 resize / 窄屏抽屉 / Escape 关闭由 layout 状态驱动。
 *
 * 根元素与侧栏的语义类名（.app-layout / .app-main / .drawer-backdrop /
 * .resize-handle / .app-sidebar-left / .app-inspector）以 :global 暴露，
 * 供 Playwright e2e 与 SSR 测试稳定匹配（参考 T4/T6 约定）。
 */
export function AppShell({ layout, active, titlebar, left, center, right }: AppShellProps) {
  const {
    reducedMotion,
    focusMode,
    drawerOpen,
    breakpoints,
    leftCollapsed,
    rightCollapsed,
    leftResizeRef,
    rightResizeRef,
    leftResize,
    rightResize,
    closeDrawers,
  } = layout;

  // 抽屉打开时 Escape 关闭（布局行为，不依赖业务数据）
  useEffect(() => {
    if (!active || !drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, drawerOpen, closeDrawers]);

  const showLeftHandle = !focusMode && !breakpoints.leftNarrow;
  const showRightHandle = !focusMode && !breakpoints.rightNarrow;

  return (
    <div
      className={`app-layout ${rootClass}`.trim()}
      data-focus-mode={focusMode ? "true" : undefined}
      data-workspace-active={active ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      {titlebar}
      <div className={`app-main ${mainClass}`.trim()}>
        {drawerOpen && (
          <div
            className={`drawer-backdrop ${backdropClass}`.trim()}
            onClick={closeDrawers}
            aria-hidden="true"
            data-testid="drawer-backdrop"
          />
        )}
        {left}
        {showLeftHandle && (
          <div
            ref={leftResizeRef}
            className={`resize-handle ${resizeClass}`.trim()}
            {...leftResize.resizeHandleProps}
          />
        )}
        {center}
        {showRightHandle && (
          <div
            ref={rightResizeRef}
            className={`resize-handle ${resizeClass}`.trim()}
            {...rightResize.resizeHandleProps}
          />
        )}
        {right}
      </div>
    </div>
  );
}
