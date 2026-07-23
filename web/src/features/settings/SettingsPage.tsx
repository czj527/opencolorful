import { useEffect, useReducer, useState } from "react";

import { ApiClient } from "../../lib/api-client.js";
import type { PreferencesDocument, SupervisorStatusResponse } from "../../lib/types.js";
import {
  SETTINGS_SECTIONS,
  initialSettingsNav,
  settingsNavReducer,
  type SettingsSectionId,
} from "./settings-state.js";
import { SettingsNav } from "./SettingsNav.js";
import { navigateToWorkspace } from "../../app/page-router.js";
import "./settings.css";

export interface SettingsPageProps {
  readonly api: ApiClient;
}

export function SettingsPage(props: SettingsPageProps) {
  const [nav, dispatch] = useReducer(settingsNavReducer, initialSettingsNav);
  const [preferences, setPreferences] = useState<PreferencesDocument | null>(null);
  const [supervisorStatus, setSupervisorStatus] = useState<SupervisorStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [prefs, status] = await Promise.all([
          props.api.getPreferences(),
          props.api.getSupervisorStatus().catch(() => null),
        ]);
        if (cancelled) return;
        setPreferences(prefs);
        if (status !== null) setSupervisorStatus(status);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "加载设置失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.api]);

  return (
    <div className="settings-page" data-page="settings">
      <header className="settings-header">
        <button
          type="button"
          className="settings-back"
          onClick={navigateToWorkspace}
          data-testid="settings-back"
        >
          ← 返回聊天
        </button>
        <h1 className="settings-title">设置中心</h1>
      </header>
      <div className="settings-body">
        <SettingsNav
          sections={SETTINGS_SECTIONS}
          activeSection={nav.activeSection}
          visibleSectionIds={nav.visibleSectionIds}
          search={nav.search}
          onSelect={(id) => dispatch({ type: "SELECT_SECTION", sectionId: id })}
          onSearch={(value) => dispatch({ type: "SET_SEARCH", search: value })}
        />
        <main className="settings-content" data-testid="settings-content">
          {loadError !== null ? (
            <div className="settings-load-error" role="alert">
              {loadError}
            </div>
          ) : preferences === null ? (
            <div className="settings-loading">加载中…</div>
          ) : (
            <SettingsContentPlaceholder
              activeSection={nav.activeSection}
              preferences={preferences}
              supervisorStatus={supervisorStatus}
            />
          )}
        </main>
      </div>
    </div>
  );
}

interface SettingsContentPlaceholderProps {
  readonly activeSection: SettingsSectionId;
  readonly preferences: PreferencesDocument;
  readonly supervisorStatus: SupervisorStatusResponse | null;
}

function SettingsContentPlaceholder(props: SettingsContentPlaceholderProps) {
  // Task 5 会用真实 section 替换本占位；当前先按 section 显示最小可读内容。
  if (props.activeSection === "future") {
    return (
      <section className="settings-section unavailable-section">
        <p>这部分能力（Profile / 记忆 / 多 Agent / 插件）尚未在 Phase 4 启用。</p>
      </section>
    );
  }
  return (
    <section className="settings-section">
      <p data-testid="settings-active-section">{props.activeSection}</p>
    </section>
  );
}