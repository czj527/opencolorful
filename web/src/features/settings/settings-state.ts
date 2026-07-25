export type SettingsSectionId = "models" | "defaults" | "layout" | "agents" | "logs" | "runtime" | "future";

export interface SettingsSectionMeta {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly group: "general" | "future";
  readonly available: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: "models", label: "模型与 Provider", group: "general", available: true },
  { id: "defaults", label: "默认对话", group: "general", available: true },
  { id: "layout", label: "界面与布局", group: "general", available: true },
  { id: "agents", label: "Agent 管理", group: "general", available: true },
  { id: "logs", label: "日志与诊断", group: "general", available: true },
  { id: "runtime", label: "运行时与关于", group: "general", available: true },
  { id: "future", label: "Profile / 记忆 / 多 Agent / 插件", group: "future", available: false },
];

export interface SettingsNavState {
  readonly activeSection: SettingsSectionId;
  readonly search: string;
  readonly visibleSectionIds: readonly SettingsSectionId[];
}

function computeVisible(search: string): readonly SettingsSectionId[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return SETTINGS_SECTIONS.map((s) => s.id);
  return SETTINGS_SECTIONS.filter((s) => s.label.toLowerCase().includes(needle)).map((s) => s.id);
}

export const initialSettingsNav: SettingsNavState = {
  activeSection: "models",
  search: "",
  visibleSectionIds: SETTINGS_SECTIONS.map((s) => s.id),
};

export function createInitialSettingsNav(search: string): SettingsNavState {
  const section = new URLSearchParams(search).get("section");
  const activeSection = SETTINGS_SECTIONS.some((candidate) => candidate.id === section)
    ? section as SettingsSectionId
    : "models";
  return { ...initialSettingsNav, activeSection };
}

export function settingsSectionUrl(sectionId: SettingsSectionId): string {
  return `/settings?section=${encodeURIComponent(sectionId)}`;
}

export type SettingsNavAction =
  | { type: "SELECT_SECTION"; sectionId: SettingsSectionId }
  | { type: "SET_SEARCH"; search: string };

export function settingsNavReducer(state: SettingsNavState, action: SettingsNavAction): SettingsNavState {
  switch (action.type) {
    case "SET_SEARCH": {
      const search = action.search;
      return { ...state, search, visibleSectionIds: computeVisible(search) };
    }
    case "SELECT_SECTION":
      return { ...state, activeSection: action.sectionId };
  }
}

export type SectionLoadStatus = "idle" | "loading" | "saving" | "saved" | "error";

export interface SectionState {
  readonly status: SectionLoadStatus;
  readonly error: string | null;
  readonly lastCursor?: string | null;
}
