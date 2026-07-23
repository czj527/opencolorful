import { useState } from "react";
import type { ProviderView, SessionView } from "../lib/types.js";
import { ProviderSettings } from "../features/providers/ProviderSettings.jsx";
import { SessionSettingsPanel } from "../features/sessions/SessionSettingsPanel.jsx";
import type { ProviderFormData } from "../features/providers/provider-form.js";

interface InspectorSidebarProps {
  readonly session: SessionView | null;
  readonly providers: ProviderView[];
  readonly collapsed: boolean;
  readonly saving: boolean;
  readonly onToggle: () => void;
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly onSaveSessionSettings: (settings: Record<string, unknown>) => Promise<void>;
  readonly onShowLogs: () => void;
}

type Tab = "session" | "provider" | "logs";

export function InspectorSidebar({
  session,
  providers,
  collapsed,
  saving,
  onToggle,
  onSaveProvider,
  onSaveSessionSettings,
  onShowLogs,
}: InspectorSidebarProps) {
  const [tab, setTab] = useState<Tab>("session");

  if (collapsed) {
    return null;
  }

  return (
    <aside className="app-inspector" role="complementary" aria-label="详情面板">
      <div className="sidebar-header">
        <div style={{ display: "flex", gap: 4 }}>
          <button
            className={`icon-button${tab === "session" ? " primary" : ""}`}
            style={{ border: "none", fontSize: 12 }}
            onClick={() => setTab("session")}
            type="button"
          >
            会话
          </button>
          <button
            className={`icon-button${tab === "provider" ? " primary" : ""}`}
            style={{ border: "none", fontSize: 12 }}
            onClick={() => setTab("provider")}
            type="button"
          >
            Provider
          </button>
          <button
            className={`icon-button${tab === "logs" ? " primary" : ""}`}
            style={{ border: "none", fontSize: 12 }}
            onClick={() => { setTab("logs"); onShowLogs(); }}
            type="button"
          >
            日志
          </button>
        </div>
      </div>
      <div className="sidebar-content" style={{ padding: 0 }}>
        {tab === "session" && (
          session ? (
            <SessionSettingsPanel
              key={session.id}
              session={session}
              onSave={onSaveSessionSettings}
              saving={saving}
            />
          ) : (
            <div className="empty-state" style={{ padding: 24 }}>
              <div style={{ fontSize: "13px" }}>选择会话查看设置</div>
            </div>
          )
        )}
        {tab === "provider" && (
          <ProviderSettings
            providers={providers}
            onSave={onSaveProvider}
            saving={saving}
          />
        )}
        {tab === "logs" && (
          <div id="supervisor-logs" style={{ padding: 12, fontSize: 12, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }} />
        )}
      </div>
    </aside>
  );
}
