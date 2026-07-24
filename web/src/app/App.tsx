import { useState, useCallback, useEffect } from "react";

import { WorkspaceApp } from "./WorkspaceApp.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { ApiClient } from "../lib/api-client.js";

const API_BASE = "";
const api = new ApiClient(API_BASE);

function isSettingsPath(): boolean {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname;
  return p === "/settings" || p.startsWith("/settings/");
}

export function App() {
  const [showSettings, setShowSettings] = useState(() => isSettingsPath());

  const onOpenSettings = useCallback(() => {
    setShowSettings(true);
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", "/settings");
    }
  }, []);

  const onCloseSettings = useCallback(() => {
    setShowSettings(false);
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", "/");
    }
  }, []);

  // 监听浏览器后退/前进；首屏直接 /settings 时依靠初始化值
  useEffect(() => {
    const sync = () => setShowSettings(isSettingsPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return (
    <>
      <div style={{ display: showSettings ? "none" : undefined }}>
        <WorkspaceApp onSettingsClick={onOpenSettings} active={!showSettings} />
      </div>
      {showSettings && (
        <SettingsPage api={api} onBack={onCloseSettings} />
      )}
    </>
  );
}
