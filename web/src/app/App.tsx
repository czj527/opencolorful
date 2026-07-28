import { useCallback, useEffect, useState } from "react";

import { WorkspaceApp } from "./WorkspaceApp.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { NewSessionPage } from "../features/sessions/NewSessionPage.js";
import { ApiClient } from "../lib/api-client.js";
import { AgentCreatePage } from "../features/agents/AgentCreatePage.js";
import { AgentEditPage } from "../features/agents/AgentEditPage.js";
import {
  navigateToSettings,
  navigateToSettingsSection,
  navigateToWorkspace,
  routeFromPathname,
  type PageRoute,
} from "./page-router.js";
import type {
  AgentView,
  ModelSummary,
  PreferencesDocument,
} from "../lib/types.js";

const API_BASE = "";
const api = new ApiClient(API_BASE);

function initialRoute(): PageRoute {
  if (typeof window === "undefined") return "workspace";
  return routeFromPathname(window.location.pathname);
}

export function App() {
  const [route, setRoute] = useState<PageRoute>(initialRoute);
  // NewSessionPage 创建会话成功后透传给 WorkspaceApp 的 sessionId
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);
  // /new 路由下独立加载的 NewSessionPage 数据源（与 WorkspaceApp 内部加载解耦，避免相互依赖）
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [preferences, setPreferences] = useState<PreferencesDocument | null>(null);

  // 监听 popstate（含 navigateToSettings/navigateToWorkspace/navigateToNewSession 触发的合成事件）
  useEffect(() => {
    const sync = () => setRoute(routeFromPathname(window.location.pathname));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Parse highlightedAgentId from settings URL
  useEffect(() => {
    if (route === "settings") {
      const search = typeof window !== "undefined" ? window.location.search : "";
      const params = new URLSearchParams(search);
      const highlight = params.get("highlight");
      if (highlight) {
        setHighlightedAgentId(highlight);
      }
    }
  }, [route]);

  // /new 路由下加载 NewSessionPage 所需的 agents/models/preferences
  useEffect(() => {
    if (route !== "session-new") return undefined;
    let cancelled = false;
    void (async () => {
      const [a, m] = await Promise.all([
        api.listAgents().catch(() => [] as AgentView[]),
        api.listModels().catch(() => [] as ModelSummary[]),
      ]);
      if (cancelled) return;
      setAgents(a);
      setModels(m);
      try {
        const p = await api.getPreferences();
        if (!cancelled) setPreferences(p);
      } catch {
        /* preferences 加载失败不阻塞 NewSessionPage，使用全局默认 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  const onOpenSettings = useCallback(() => {
    navigateToSettings();
  }, []);

  const onCloseSettings = useCallback(() => {
    navigateToWorkspace();
  }, []);

  // NewSessionPage 创建会话成功 → 透传 sessionId 给 WorkspaceApp，并切回工作台路由
  const handleSessionCreated = useCallback((sessionId: string) => {
    setCreatedSessionId(sessionId);
    navigateToWorkspace();
  }, []);

  // WorkspaceApp 加载完成后清空透传状态
  const handleSessionCreatedConsumed = useCallback(() => {
    setCreatedSessionId(null);
  }, []);

  return (
    <>
      <div style={{ display: route !== "workspace" ? "none" : undefined }}>
        <WorkspaceApp
          onSettingsClick={onOpenSettings}
          active={route === "workspace"}
          createdSessionId={createdSessionId}
          onSessionCreatedConsumed={handleSessionCreatedConsumed}
        />
      </div>
      {route === "settings" && (
        <SettingsPage
          api={api}
          onBack={onCloseSettings}
          highlightedAgentId={highlightedAgentId}
          onHighlightConsumed={() => setHighlightedAgentId(null)}
        />
      )}
      {route === "session-new" && (
        <NewSessionPage
          agents={agents}
          api={api}
          models={models}
          preferences={preferences}
          onSessionCreated={handleSessionCreated}
        />
      )}
      {route === "agent-new" && (
        <AgentCreatePage api={api} />
      )}
      {route === "agent-edit" && (
        <AgentEditPage api={api} />
      )}
    </>
  );
}
