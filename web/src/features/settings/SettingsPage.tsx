import { useEffect, useReducer, useState } from "react";

import { ApiClient } from "../../lib/api-client.js";
import type { ModelSummary, PreferencesDocument, ProviderView, SupervisorStatusResponse } from "../../lib/types.js";
import type { ProviderFormData } from "../providers/provider-form.js";
import {
  SETTINGS_SECTIONS,
  initialSettingsNav,
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
import { navigateToWorkspace } from "../../app/page-router.js";
import "./settings.css";

export interface SettingsPageProps {
  readonly api: ApiClient;
}

export function SettingsPage(props: SettingsPageProps) {
  const [nav, dispatch] = useReducer(settingsNavReducer, initialSettingsNav);
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
      try {
        const [prefs, status, provs, mods] = await Promise.all([
          props.api.getPreferences(),
          props.api.getSupervisorStatus().catch(() => null),
          props.api.listProviders().catch(() => [] as ProviderView[]),
          props.api.listModels().catch(() => [] as ModelSummary[]),
        ]);
        if (cancelled) return;
        setPreferences(prefs);
        if (status !== null) setSupervisorStatus(status);
        setProviders(provs);
        setModels(mods);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "加载设置失败");
        }
      }
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
    } finally {
      setSaving(false);
    }
  };

  const getSupervisorLogs = async (query?: { limit?: number; level?: "all" | "info" | "warn" | "error"; query?: string }) => {
    return props.api.getSupervisorLogs(query);
  };

  return (
    <div className="settings-page" data-page="settings">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={navigateToWorkspace} data-testid="settings-back">
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
            <div className="settings-load-error" role="alert">{loadError}</div>
          ) : preferences === null ? (
            <div className="settings-loading">加载中…</div>
          ) : (
            renderSection(nav.activeSection, {
              preferences,
              supervisorStatus,
              providers,
              models,
              onSavePreferences: handleSavePreferences,
              onSaveLayout: handleSaveLayout,
              onSaveProvider: handleSaveProvider,
              onGetSupervisorLogs: getSupervisorLogs,
              saving,
              saveError,
            })
          )}
        </main>
      </div>
    </div>
  );
}

interface SectionRenderProps {
  readonly preferences: PreferencesDocument;
  readonly supervisorStatus: SupervisorStatusResponse | null;
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelSummary[];
  readonly onSavePreferences: (defaults: PreferencesDocument["defaults"]) => Promise<void>;
  readonly onSaveLayout: (layout: PreferencesDocument["layout"]) => Promise<void>;
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly onGetSupervisorLogs: (query?: { limit?: number; level?: "all" | "info" | "warn" | "error"; query?: string }) => Promise<{ logs: string; truncated: boolean; nextCursor: string | null }>;
  readonly saving: boolean;
  readonly saveError: string | null;
}

function renderSection(active: SettingsSectionId, props: SectionRenderProps) {
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
          saving={props.saving}
          lastSaveError={props.saveError}
        />
      );
    case "logs":
      return <LogsSection getSupervisorLogs={props.onGetSupervisorLogs} />;
    case "runtime":
      return <RuntimeSection supervisorStatus={props.supervisorStatus} />;
    case "future":
      return <UnavailableSection />;
  }
}