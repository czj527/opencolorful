import { useEffect, useReducer, useState } from "react";

import { ApiClient } from "../../lib/api-client.js";
import type { ModelSummary, PreferencesDocument, ProviderView, SupervisorStatusResponse } from "../../lib/types.js";
import type { ProviderFormData } from "../providers/provider-form.js";
import {
  SETTINGS_SECTIONS,
  createInitialSettingsNav,
  settingsSectionUrl,
  settingsNavReducer,
  type SettingsSectionId,
} from "./settings-state.js";
import { SettingsNav } from "./SettingsNav.js";
import { ProvidersSection } from "./sections/ProvidersSection.js";
import { DefaultsSection } from "./sections/DefaultsSection.js";
import { LayoutSection } from "./sections/LayoutSection.js";
import { LogsSection } from "./sections/LogsSection.js";
import { RuntimeSection } from "./sections/RuntimeSection.js";
import { UnavailableSection } from "./sections/UnavailableSection.js";
import "./settings.css";

export interface SettingsPageProps {
  readonly api: ApiClient;
  readonly onBack: () => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const [nav, dispatch] = useReducer(
    settingsNavReducer,
    undefined,
    () => createInitialSettingsNav(typeof window === "undefined" ? "" : window.location.search),
  );
  const [preferences, setPreferences] = useState<PreferencesDocument | null>(null);
  const [supervisorStatus, setSupervisorStatus] = useState<SupervisorStatusResponse | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Supervisor 状态独立加载：Agent 停止时仍可访问
      try {
        const status = await props.api.getSupervisorStatus();
        if (!cancelled) setSupervisorStatus(status);
      } catch { /* Supervisor 不可达——日志与 Runtime section 各自处理 */ }

      // Preferences 可能因 Agent 停止而 502，失败不阻塞整个页面
      try {
        const prefs = await props.api.getPreferences();
        if (!cancelled) setPreferences(prefs);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "偏好加载失败");
      }

      // Provider/Model 异步加载，失败不影响诊断
      try {
        const [provs, mods] = await Promise.all([
          props.api.listProviders().catch(() => [] as ProviderView[]),
          props.api.listModels().catch(() => [] as ModelSummary[]),
        ]);
        if (!cancelled) { setProviders(provs); setModels(mods); }
      } catch { /* 忽略 */ }
    })();
    return () => { cancelled = true; };
  }, [props.api]);

  const handleSavePreferences = async (defaults: PreferencesDocument["defaults"]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await props.api.updatePreferences({ defaults });
      setPreferences(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      setSaveError(msg);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveLayout = async (layout: PreferencesDocument["layout"]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await props.api.updatePreferences({ layout });
      setPreferences(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      setSaveError(msg);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAppearance = async (theme: PreferencesDocument["appearance"]["theme"]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await props.api.updatePreferences({ appearance: { theme } });
      setPreferences(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      setSaveError(msg);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProvider = async (data: ProviderFormData) => {
    setSaving(true);
    setSaveError(null);
    try {
      await props.api.updateProvider(
        {
          providerId: data.providerId, name: data.name, protocol: data.protocol,
          baseUrl: data.baseUrl,
          models: [{ modelId: data.modelId, name: data.modelName || data.modelId,
            capabilities: { reasoning: data.reasoning, input: ["text"], contextWindow: data.contextWindow, maxTokens: data.maxTokens } }],
        },
        data.apiKey || undefined,
      );
      const [provs, mods] = await Promise.all([props.api.listProviders(), props.api.listModels()]);
      setProviders(provs);
      setModels(mods);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Provider 保存失败");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const getSupervisorLogs = async (query?: { limit?: number; level?: "all" | "info" | "warn" | "error"; query?: string; since?: string | null }) => {
    return props.api.getSupervisorLogs(query);
  };

  return (
    <div className="settings-page" data-page="settings">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={props.onBack} data-testid="settings-back">
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
          onSelect={(id) => {
            dispatch({ type: "SELECT_SECTION", sectionId: id });
            window.history.replaceState({}, "", settingsSectionUrl(id));
          }}
          onSearch={(value) => dispatch({ type: "SET_SEARCH", search: value })}
        />
        <main className="settings-content" data-testid="settings-content">
          {renderSection(nav.activeSection, {
            preferences,
            supervisorStatus,
            providers,
            models,
            onSavePreferences: handleSavePreferences,
            onSaveLayout: handleSaveLayout,
            onSaveTheme: handleSaveAppearance,
            onSaveProvider: handleSaveProvider,
            onGetSupervisorLogs: getSupervisorLogs,
            saving,
            saveError,
            loadError,
          })}
        </main>
      </div>
    </div>
  );
}

interface SectionRenderProps {
  readonly preferences: PreferencesDocument | null;
  readonly supervisorStatus: SupervisorStatusResponse | null;
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelSummary[];
  readonly onSavePreferences: (defaults: PreferencesDocument["defaults"]) => Promise<void>;
  readonly onSaveLayout: (layout: PreferencesDocument["layout"]) => Promise<void>;
  readonly onSaveTheme: (theme: PreferencesDocument["appearance"]["theme"]) => Promise<void>;
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly onGetSupervisorLogs: (query?: { limit?: number; level?: "all" | "info" | "warn" | "error"; query?: string; since?: string | null }) => Promise<{ logs: string; truncated: boolean; nextCursor: string | null }>;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly loadError: string | null;
}

function renderSection(active: SettingsSectionId, props: SectionRenderProps) {
  // 独立于 Agent 的 section：即使 Agent 停止也可用
  if (active === "logs") return <LogsSection getSupervisorLogs={props.onGetSupervisorLogs} />;
  if (active === "runtime") return <RuntimeSection supervisorStatus={props.supervisorStatus} />;
  if (active === "future") return <UnavailableSection />;

  // 以下 section 依赖 Agent/preferences
  if (props.loadError !== null) {
    return <div className="settings-load-error" role="alert">{props.loadError}</div>;
  }
  if (props.preferences === null) {
    return <div className="settings-loading">加载中…</div>;
  }

  switch (active) {
    case "models":
      return (
        <ProvidersSection
          providers={props.providers}
          onSaveProvider={props.onSaveProvider}
          saving={props.saving}
          lastSaveError={props.saveError}
        />
      );
    case "defaults":
      return (
        <DefaultsSection
          preferences={props.preferences}
          models={props.models}
          onSave={props.onSavePreferences}
          saving={props.saving}
          lastSaveError={props.saveError}
        />
      );
    case "layout":
      return (
        <LayoutSection
          preferences={props.preferences}
          onSave={props.onSaveLayout}
          onSaveTheme={props.onSaveTheme}
          saving={props.saving}
          lastSaveError={props.saveError}
        />
      );
    default:
      return null;
  }
}
