import { afterEach, beforeAll, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

import { updateLocalPrefs } from "../data/local-prefs.js";

/**
 * L5 测试环境全局 setup（happy-dom）。
 *
 * - happy-dom 未实现 window.matchMedia：theme.ts 的 systemTheme() 与
 *   useTheme 的 change 监听都依赖它，提供 matches=false 的确定性 stub
 *   （首次渲染解析为 light 主题，用例可显式驱动切换）。
 * - happy-dom 未实现 IntersectionObserver：占位实现，防止依赖懒渲染的组件抛错。
 * - localStorage 是跨用例共享的持久化层（主题 / local-prefs）：每个用例前清空，
 *   并把 local-prefs 的模块级状态显式复位（该状态在 import 时加载一次，
 *   不复位会造成用例顺序耦合，违反套件可重复运行约定）。
 */
beforeAll(() => {
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
    class IntersectionObserverStub {
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
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
  }
});

beforeEach(() => {
  window.localStorage.clear();
  updateLocalPrefs({ reduceMotion: false, showThinking: true, showToolCalls: true });
});

// 每个用例后清理 @testing-library 挂载的 DOM，避免用例间污染
afterEach(() => {
  cleanup();
});
