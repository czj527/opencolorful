import { useState, useCallback, useEffect } from "react";

import { WorkspaceApp } from "./WorkspaceApp.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { ApiClient } from "../lib/api-client.js";

const API_BASE = "";
const api = new ApiClient(API_BASE);

export function App() {
  const [showSettings, setShowSettings] = useState(false);

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

  // 监听浏览器后退/前进
  useEffect(() => {
    const sync = () => {
      const pathname = window.location.pathname;
      setShowSettings(pathname === "/settings" || pathname.startsWith("/settings/"));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return (
    <>
      <div style={{ display: showSettings ? "none" : undefined }}>
        <WorkspaceApp onSettingsClick={onOpenSettings} />
      </div>
      {showSettings && (
        <SettingsPage api={api} onBack={onCloseSettings} />
      )}
    </>
  );
}