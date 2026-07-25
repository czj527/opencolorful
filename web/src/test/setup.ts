import { afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * 测试环境全局 setup（happy-dom）。
 *
 * - 默认注入 dark 主题到 document.documentElement.dataset.theme，
 *   保证依赖 [data-theme] CSS 变量的组件在测试中有一致的主题上下文。
 * - happy-dom 不实现 window.matchMedia，需要 mock 以免依赖响应式断点 /
 *   prefers-reduced-motion 的组件（如 WorkspaceApp）在渲染期抛错。
 * - happy-dom 不实现 IntersectionObserver，部分懒渲染/虚拟列表组件依赖它，
 *   这里提供一个无副作用的占位实现。
 */
beforeAll(() => {
  document.documentElement.dataset.theme = "dark";

  if (!("matchMedia" in window) || typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === "undefined") {
    class IntersectionObserver {
      readonly root: Element | null = null;
      readonly rootMargin: string = "";
      readonly thresholds: ReadonlyArray<number> = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserver;
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserver;
  }
});

// 每个用例后清理 @testing-library 挂载的 DOM，避免用例间污染
afterEach(() => {
  cleanup();
});
