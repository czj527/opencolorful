import { useSyncExternalStore } from "react";

/**
 * 桌面端本地界面偏好（切片 1.5 T8）。
 * 只影响本机显示，不走服务端；localStorage 持久化。
 * 与服务端偏好（GET/PUT /api/settings/preferences）是两套独立数据。
 */
export interface LocalPrefs {
  /** 减少动效（系统级 prefers-reduced-motion 由 CSS media query 独立兜底） */
  readonly reduceMotion: boolean;
  /** 会话时间线显示思考事件 */
  readonly showThinking: boolean;
  /** 会话时间线显示工具调用事件 */
  readonly showToolCalls: boolean;
}

const STORAGE_KEY = "ocf-desktop-local-prefs";

const DEFAULTS: LocalPrefs = {
  reduceMotion: false,
  showThinking: true,
  showToolCalls: true,
};

function load(): LocalPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      reduceMotion: parsed["reduceMotion"] === true,
      showThinking: parsed["showThinking"] !== false,
      showToolCalls: parsed["showToolCalls"] !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

let current: LocalPrefs = load();
const listeners = new Set<() => void>();

export function getLocalPrefs(): LocalPrefs {
  return current;
}

export function updateLocalPrefs(patch: Partial<LocalPrefs>): void {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // 存储不可用时偏好仅本次会话生效
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React 订阅入口：任一组件更新偏好，所有消费方同步重渲染 */
export function useLocalPrefs(): LocalPrefs {
  return useSyncExternalStore(subscribe, getLocalPrefs);
}
