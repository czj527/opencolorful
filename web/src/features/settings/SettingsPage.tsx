import { useEffect, useReducer, useState } from "react";

import { ApiClient } from "../../lib/api-client.js";
import type {
  AgentView,
  ModelSummary,
  PreferencesDocument,
  ProviderView,
  SupervisorStatusResponse,
} from "../../lib/types.js";
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
import { navigateToAgentNew, navigateToAgentEdit } from "../../app/page-router.js";
import { AgentsSection } from "./sections/AgentsSection.js";
import { UsageSection } from "./sections/UsageSection.js";
import { SettingsSection } from "./widgets/index.js";
import styles from "./SettingsPage.module.css";

export interface SettingsPageProps {
  readonly api: ApiClient;
  readonly onBack: () => void;
  readonly highlightedAgentId?: string | null | undefined;
  readonly onHighlightConsumed?: (() => void) | undefined;
}

/** 各 section 的标题与描述，由 SettingsPage 统一通过 SettingsSection 呈现。 */
const SECTION_META: Record<SettingsSectionId, { title: string; description: string }> = {
  models: { title: "模型与 Provider", description: "管理已配置的模型 Provider 与凭据。" },
  defaults: { title: "默认对话", description: "新建 Session 时的默认行为。已有 Session 的显式设置不受影响。" },
  layout: { title: "界面与布局", description: "调整侧栏宽度、焦点模式、动态效果与显示偏好。" },
  agents: { title: "Agent 管理", description: "管理 Agent 身份、个性与回复风格。" },
  logs: { title: "日志与诊断", description: "Supervisor 和 Agent Server 运行日志。" },
  usage: { title: "用量统计", description: "查看 Token 消耗与缓存命中情况，支持按时间范围筛选。" },
  runtime: { title: "运行时与关于", description: "当前进程状态与版本信息。" },
  future: { title: "Profile / 记忆 / 多 Agent / 插件", description: "后续阶段规划的能力，当前尚未开放。" },
};

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
  const [agents, setAgents] = useState<AgentView[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Supervisor 状态独立加载：Agent 停止时仍可访问
      try {
        const status = await props.api.getSupervisorStatus();
        if (!cancelled) setSupervisorStatus(status);
      } catch {
        /* Supervisor 不可达——日志与 Runtime section 各自处理 */
      }

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
        if (!cancelled) {
          setProviders(provs);
          setModels(mods);
        }
      } catch {
        /* 忽略 */
      }

      // Agent 列表异步加载，失败不阻塞其他 section
      try {
        const agentList = await props.api.listAgents();
        if (!cancelled) setAgents(agentList);
      } catch {
        /* Agent 列表加载失败，不影响其他功能 */
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const handleSaveAppearance = async (appearance: Partial<PreferencesDocument["appearance"]>) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await props.api.updatePreferences({ appearance });
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
          providerId: data.providerId,
          name: data.name,
          protocol: data.protocol,
          baseUrl: data.baseUrl,
          models: [
            {
              modelId: data.modelId,
              name: data.modelName || data.modelId,
              capabilities: {
                reasoning: data.reasoning,
                input: ["text"],
                contextWindow: data.contextWindow,
                maxTokens: data.maxTokens,
              },
            },
          ],
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

  const refreshAgents = async () => {
    try {
      const list = await props.api.listAgents();
      setAgents(list);
    } catch {
      /* 忽略 */
    }
  };

  const handleArchiveAgent = async (id: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await props.api.archiveAgent(id);
      await refreshAgents();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Agent 归档失败");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const getSupervisorLogs = async (query?: {
    limit?: number;
    level?: "all" | "info" | "warn" | "error";
    query?: string;
    since?: string | null;
  }) => {
    return props.api.getSupervisorLogs(query);
  };

  const getUsageSummary = async (days: number) => {
    return props.api.usageSummary(days);
  };

  return (
    <div className={styles.page} data-page="settings">
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          onClick={props.onBack}
          data-testid="settings-back"
        >
          ← 返回聊天
        </button>
        <h1 className={styles.title}>设置中心</h1>
      </header>
      <div className={styles.body}>
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
        <main className={styles.content} data-testid="settings-content">
          {renderSection(nav.activeSection, {
            api: props.api,
            preferences,
            supervisorStatus,
            providers,
            models,
            agents,
            highlightedAgentId: props.highlightedAgentId,
            onHighlightConsumed: props.onHighlightConsumed,
            onSavePreferences: handleSavePreferences,
            onSaveLayout: handleSaveLayout,
            onSaveTheme: handleSaveAppearance,
            onSaveProvider: handleSaveProvider,
            onGetSupervisorLogs: getSupervisorLogs,
            onGetUsageSummary: getUsageSummary,
            onArchiveAgent: handleArchiveAgent,
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
  readonly api: ApiClient;
  readonly preferences: PreferencesDocument | null;
  readonly supervisorStatus: SupervisorStatusResponse | null;
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelSummary[];
  readonly agents: readonly AgentView[];
  readonly highlightedAgentId?: string | null | undefined;
  readonly onHighlightConsumed?: (() => void) | undefined;
  readonly onSavePreferences: (defaults: PreferencesDocument["defaults"]) => Promise<void>;
  readonly onSaveLayout: (layout: PreferencesDocument["layout"]) => Promise<void>;
  readonly onSaveTheme: (appearance: Partial<PreferencesDocument["appearance"]>) => Promise<void>;
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly onGetSupervisorLogs: (query?: {
    limit?: number;
    level?: "all" | "info" | "warn" | "error";
    query?: string;
    since?: string | null;
  }) => Promise<{ logs: string; truncated: boolean; nextCursor: string | null }>;
  readonly onGetUsageSummary: (days: number) => Promise<import("../../lib/types.js").UsageSummaryResponse>;
  readonly onArchiveAgent: (id: string) => Promise<void>;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly loadError: string | null;
}

function renderSection(active: SettingsSectionId, props: SectionRenderProps) {
  const meta = SECTION_META[active];

  // 独立于 Agent 的 section：即使 Agent 停止也可用
  if (active === "logs") {
    return (
      <SettingsSection title={meta.title} description={meta.description} testId="settings-section-logs">
        <LogsSection getSupervisorLogs={props.onGetSupervisorLogs} />
      </SettingsSection>
    );
  }
  if (active === "usage") {
    return (
      <SettingsSection title={meta.title} description={meta.description} testId="settings-section-usage">
        <UsageSection getUsageSummary={props.onGetUsageSummary} />
      </SettingsSection>
    );
  }
  if (active === "runtime") {
    return (
      <SettingsSection title={meta.title} description={meta.description} testId="settings-section-runtime">
        <RuntimeSection supervisorStatus={props.supervisorStatus} />
      </SettingsSection>
    );
  }
  if (active === "agents") {
    return (
      <SettingsSection title={meta.title} description={meta.description} testId="settings-section-agents">
        <AgentsSection
          agents={props.agents}
          highlightedAgentId={props.highlightedAgentId}
          onNavigateNew={navigateToAgentNew}
          onNavigateEdit={navigateToAgentEdit}
          onArchive={props.onArchiveAgent}
        />
      </SettingsSection>
    );
  }
  if (active === "future") {
    return (
      <SettingsSection title={meta.title} description={meta.description} testId="settings-section-future">
        <UnavailableSection />
      </SettingsSection>
    );
  }

  // 以下 section 依赖 Agent/preferences
  if (props.loadError !== null) {
    return (
      <div className={styles.loadError} role="alert">
        {props.loadError}
      </div>
    );
  }
  if (props.preferences === null) {
    return <div className={styles.loading}>加载中…</div>;
  }

  switch (active) {
    case "models":
      return (
        <SettingsSection title={meta.title} description={meta.description} testId="settings-section-providers">
          <ProvidersSection
            providers={props.providers}
            onSaveProvider={props.onSaveProvider}
            saving={props.saving}
            lastSaveError={props.saveError}
          />
        </SettingsSection>
      );
    case "defaults":
      return (
        <SettingsSection title={meta.title} description={meta.description} testId="settings-section-defaults">
          <DefaultsSection
            preferences={props.preferences}
            models={props.models}
            onSave={props.onSavePreferences}
            saving={props.saving}
            lastSaveError={props.saveError}
          />
        </SettingsSection>
      );
    case "layout":
      return (
        <SettingsSection title={meta.title} description={meta.description} testId="settings-section-layout">
          <LayoutSection
            preferences={props.preferences}
            onSave={props.onSaveLayout}
            onSaveTheme={props.onSaveTheme}
            saving={props.saving}
            lastSaveError={props.saveError}
          />
        </SettingsSection>
      );
    default:
      return null;
  }
}
