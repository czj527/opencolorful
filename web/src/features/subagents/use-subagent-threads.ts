// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：主对话 Subagent 卡片数据（plans/phase-14.md §17.4 / §21.1）
//
// 职责：
// - 发现当前父 Session 的 Thread（activity `subagent.thread.created` 事件，
//   scope.sessionId=父 Session；服务端无 session 级列表端点）；
// - 每个 Thread 拉取 transcript 摘要（thread+runs+artifacts+简报快照）；
// - 每个 Thread 订阅 `subagent:<threadId>` 流（§17.4：主对话只订阅卡片摘要），
//   事件到达后防抖刷新该卡片 transcript（含 Artifact 数量等摘要字段）；
// - 卡片按创建时间升序稳定展示（不因实时更新跳动布局）。
//
// 面板打开时（openPanelThreadId）跳过卡片侧订阅，避免与面板流重复连接；
// 面板关闭后由 refresh/发现轮询兜底同步。
// ═══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client.js";
import type {
  SubagentOwnership,
  SubagentThreadId,
  SubagentThreadTranscript,
} from "../../lib/types.js";
import { SubagentStreamClient } from "./subagent-stream.js";

export interface SubagentCardData {
  readonly threadId: SubagentThreadId;
  /** 创建时间（活动事件 recordedAt；卡片按此稳定排序） */
  readonly createdAt: string;
  readonly transcript: SubagentThreadTranscript | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UseSubagentThreadsOptions {
  readonly api: ApiClient;
  readonly ownership: SubagentOwnership | null;
  /** 工作台 active 且 Agent 连接在线时启用发现与订阅 */
  readonly enabled: boolean;
  /** 面板当前打开的 Thread（跳过卡片侧订阅，避免重复连接） */
  readonly openPanelThreadId: SubagentThreadId | null;
  readonly discoverIntervalMs?: number;
  readonly refreshDebounceMs?: number;
}

const DEFAULT_DISCOVER_INTERVAL_MS = 20_000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 800;

interface InternalCardState {
  readonly threadId: SubagentThreadId;
  readonly createdAt: string;
  transcript: SubagentThreadTranscript | null;
  loading: boolean;
  error: string | null;
}

export function useSubagentThreads(options: UseSubagentThreadsOptions): {
  readonly cards: readonly SubagentCardData[];
  readonly discoveryLoading: boolean;
  readonly discoveryError: string | null;
  readonly refresh: () => void;
} {
  const { api, ownership, enabled, openPanelThreadId } = options;
  const discoverIntervalMs = options.discoverIntervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS;
  const refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;

  // 以 Record<threadId, InternalCardState> 存储，稳定引用、按创建时间排序输出
  const [byId, setById] = useState<Readonly<Record<string, InternalCardState>>>({});
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const streamClients = useRef(new Map<string, SubagentStreamClient>());
  const sessionKey = ownership !== null ? ownership.parentSessionId : null;
  const previousSessionKey = useRef<string | null>(null);

  const fetchTranscript = useCallback(async (apiClient: ApiClient, threadId: SubagentThreadId, owner: SubagentOwnership) => {
    try {
      const transcript = await apiClient.getSubagentTranscript(threadId, owner, { limit: 200 });
      setById((prev) => {
        const existing = prev[threadId];
        if (existing === undefined) return prev;
        return { ...prev, [threadId]: { ...existing, transcript, loading: false, error: null } };
      });
    } catch (error) {
      setById((prev) => {
        const existing = prev[threadId];
        if (existing === undefined) return prev;
        return {
          ...prev,
          [threadId]: {
            ...existing,
            loading: false,
            error: error instanceof Error ? error.message : "Subagent 卡片加载失败",
          },
        };
      });
    }
  }, []);

  // 发现：activity 事件 → 新 Thread 进入卡片列表并拉取 transcript
  const discover = useCallback(async (apiClient: ApiClient, owner: SubagentOwnership) => {
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const result = await apiClient.listSubagentThreads(owner);
      const next: Record<string, InternalCardState> = { ...byIdRef.current };
      let changed = false;
      for (const item of result.items) {
        if (next[item.threadId] !== undefined) continue;
        next[item.threadId] = {
          threadId: item.threadId,
          createdAt: item.createdAt,
          transcript: null,
          loading: true,
          error: null,
        };
        changed = true;
      }
      if (changed) setById(next);
      for (const item of result.items) {
        if (byIdRef.current[item.threadId] === undefined) {
          void fetchTranscript(apiClient, item.threadId, owner);
        }
      }
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : "Subagent 列表加载失败");
    } finally {
      setDiscoveryLoading(false);
    }
  }, [fetchTranscript]);

  // byId 的最新引用（供 discover 回调闭包读取，避免依赖抖动）
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;

  const clearPendingRefresh = useCallback((threadId: string) => {
    const timer = refreshTimers.current.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      refreshTimers.current.delete(threadId);
    }
  }, []);

  const scheduleRefresh = useCallback((threadId: string) => {
    if (refreshTimers.current.has(threadId)) return;
    const timer = setTimeout(() => {
      refreshTimers.current.delete(threadId);
      const owner = ownershipRef.current;
      if (owner !== null) void fetchTranscript(api, threadId as SubagentThreadId, owner);
    }, refreshDebounceMs);
    refreshTimers.current.set(threadId, timer);
  }, [api, fetchTranscript, refreshDebounceMs]);

  // 会话切换 → 整体重置（§21.2：切换主对话后不显示旧 Session Thread）
  useEffect(() => {
    if (sessionKey !== previousSessionKey.current) {
      previousSessionKey.current = sessionKey;
      for (const timer of refreshTimers.current.values()) clearTimeout(timer);
      refreshTimers.current.clear();
      disposeStreamClients();
      setById({});
      setDiscoveryError(null);
    }
  }, [sessionKey]);

  // 发现：立即 + 定时轮询（新 Thread 由 spawn 创建后进入列表）
  useEffect(() => {
    if (!enabled || ownership === null) return undefined;
    const owner = ownership;
    void discover(api, owner);
    const interval = setInterval(() => void discover(api, owner), discoverIntervalMs);
    return () => clearInterval(interval);
  }, [enabled, ownership, api, discover, discoverIntervalMs]);

  // 卡片摘要订阅：每个 Thread 一个 `subagent:<threadId>` 流（面板打开时跳过）。
  // 只在 Thread 集合/开关变化时增补连接；卡片状态更新（setById）不重建连接。
  const threadIdsKey = Object.keys(byId).sort().join(",");
  useEffect(() => {
    if (!enabled || ownership === null) return undefined;
    const owner = ownership;
    for (const threadId of threadIdsKey.split(",").filter((id) => id.length > 0)) {
      if (threadId === openPanelThreadId) continue;
      if (streamClients.current.has(threadId)) continue;
      const client = new SubagentStreamClient({
        baseUrl: "",
        threadId: threadId as SubagentThreadId,
        ownership: owner,
        onEvent: (event) => {
          if (event.type === "snapshot") {
            // reset 重建基线：直接以快照更新，无需防抖
            clearPendingRefresh(threadId);
            setById((prev) => {
              const existing = prev[threadId];
              if (existing === undefined) return prev;
              return { ...prev, [threadId]: { ...existing, transcript: event.transcript, loading: false, error: null } };
            });
            return;
          }
          if (event.type === "envelope" || event.type === "reset") {
            scheduleRefresh(threadId);
          }
        },
      });
      streamClients.current.set(threadId, client);
      client.connect();
    }
    // 组件卸载/会话切换时统一释放（不随卡片状态更新重建）
    return () => {
      if (enabled) return undefined;
      return undefined;
    };
  }, [enabled, ownership, threadIdsKey, openPanelThreadId]);

  // 面板打开 → 释放该 Thread 的卡片侧订阅（面板自己建流）
  useEffect(() => {
    if (openPanelThreadId === null) return;
    const client = streamClients.current.get(openPanelThreadId);
    if (client !== undefined) {
      client.dispose();
      streamClients.current.delete(openPanelThreadId);
    }
  }, [openPanelThreadId]);

  // 卸载时释放全部订阅
  const disposeStreamClients = useCallback(() => {
    for (const client of streamClients.current.values()) client.dispose();
    streamClients.current.clear();
  }, []);
  useEffect(() => disposeStreamClients, [disposeStreamClients]);

  const refresh = useCallback(() => {
    if (ownership === null) return;
    void discover(api, ownership);
    for (const threadId of Object.keys(byId)) {
      void fetchTranscript(api, threadId as SubagentThreadId, ownership);
    }
  }, [api, ownership, byId, discover, fetchTranscript]);

  const cards: SubagentCardData[] = Object.values(byId)
    .map((card) => ({
      threadId: card.threadId,
      createdAt: card.createdAt,
      transcript: card.transcript,
      loading: card.loading,
      error: card.error,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return { cards, discoveryLoading, discoveryError, refresh };
}
