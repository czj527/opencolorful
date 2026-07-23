import type { SettingsSectionId, SettingsSectionMeta } from "./settings-state.js";

export interface SettingsNavProps {
  readonly sections: readonly SettingsSectionMeta[];
  readonly activeSection: SettingsSectionId;
  readonly visibleSectionIds: readonly SettingsSectionId[];
  readonly search: string;
  readonly onSelect: (id: SettingsSectionId) => void;
  readonly onSearch: (value: string) => void;
}

export function SettingsNav(props: SettingsNavProps) {
  const visible = props.sections.filter((s) => props.visibleSectionIds.includes(s.id));
  return (
    <nav className="settings-nav" aria-label="设置导航">
      <input
        type="search"
        className="settings-search"
        placeholder="搜索设置项"
        value={props.search}
        onChange={(e) => props.onSearch(e.currentTarget.value)}
        aria-label="搜索设置项"
      />
      <ul className="settings-nav-list">
        {visible.map((section) => {
          const isActive = section.id === props.activeSection;
          const disabled = !section.available;
          return (
            <li key={section.id}>
              <button
                type="button"
                className={`settings-nav-item ${isActive ? "active" : ""} ${disabled ? "unavailable" : ""}`}
                aria-current={isActive ? "true" : undefined}
                aria-disabled={disabled ? "true" : undefined}
                onClick={disabled ? undefined : () => props.onSelect(section.id)}
                data-testid={`settings-nav-${section.id}`}
              >
                {section.label}
                {disabled ? <span className="settings-nav-hint">尚未启用</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}