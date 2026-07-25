import type { SettingsSectionId, SettingsSectionMeta } from "./settings-state.js";
import styles from "./SettingsNav.module.css";

export interface SettingsNavProps {
  readonly sections: readonly SettingsSectionMeta[];
  readonly activeSection: SettingsSectionId;
  readonly visibleSectionIds: readonly SettingsSectionId[];
  readonly search: string;
  readonly onSelect: (id: SettingsSectionId) => void;
  readonly onSearch: (value: string) => void;
}

function groupLabel(group: string): string {
  return group === "future" ? "后续规划" : "通用设置";
}

export function SettingsNav(props: SettingsNavProps) {
  const visible = props.sections.filter((s) => props.visibleSectionIds.includes(s.id));
  const showGroups = props.search.trim().length === 0;

  let lastGroup = "";

  return (
    <nav className={styles.nav} aria-label="设置导航">
      <input
        type="search"
        className={styles.search}
        placeholder="搜索设置项..."
        value={props.search}
        onChange={(e) => props.onSearch(e.currentTarget.value)}
        aria-label="搜索设置项"
      />
      <ul className={styles.list}>
        {visible.map((section) => {
          const isActive = section.id === props.activeSection;
          const disabled = !section.available;

          const groupHeader =
            showGroups && section.group !== lastGroup
              ? ((lastGroup = section.group),
                (
                  <li key={`group-${section.group}`} className={styles.groupLabel}>
                    {groupLabel(section.group)}
                  </li>
                ))
              : null;
          if (!showGroups) lastGroup = section.group;

          const itemClass = [
            styles.item,
            isActive ? styles.active : "",
            disabled ? styles.unavailable : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <li key={section.id}>
              {groupHeader}
              <button
                type="button"
                className={itemClass}
                aria-current={isActive ? "true" : undefined}
                aria-disabled={disabled ? "true" : undefined}
                onClick={disabled ? undefined : () => props.onSelect(section.id)}
                data-testid={`settings-nav-${section.id}`}
              >
                {section.label}
                {disabled && <span className={styles.hint}>规划中</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
