import { useState } from "react";
import type { PreferencesDocument } from "../../../lib/types.js";
import { Button, Select, Toggle } from "../../../components/ui/index.js";
import { SettingsRow, SettingsInlineRow, SettingsSubsection, SettingsSaveFeedback } from "../widgets/index.js";
import { StepSlider } from "../widgets/index.js";
import styles from "./LayoutSection.module.css";

export interface LayoutSectionProps {
  readonly preferences: PreferencesDocument;
  readonly onSave: (layout: PreferencesDocument["layout"]) => Promise<void>;
  readonly onSaveTheme: (appearance: Partial<PreferencesDocument["appearance"]>) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

export function LayoutSection(props: LayoutSectionProps) {
  const layout = props.preferences.layout;
  const appearance = props.preferences.appearance;
  const [form, setForm] = useState(layout);
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [themeSaved, setThemeSaved] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaved(false);
    setLocalError(null);
    try {
      await props.onSave(form);
      setSaved(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "保存失败");
    }
  };

  const handleThemeChange = async (theme: PreferencesDocument["appearance"]["theme"]) => {
    setThemeSaved(false);
    setThemeError(null);
    try {
      await props.onSaveTheme({ theme });
      setThemeSaved(true);
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : "主题保存失败");
    }
  };

  const handleToggleShowToolCalls = async (checked: boolean) => {
    setThemeSaved(false);
    setThemeError(null);
    try {
      await props.onSaveTheme({ showToolCalls: checked });
      setThemeSaved(true);
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : "显示工具调用保存失败");
    }
  };

  const handleToggleShowThinking = async (checked: boolean) => {
    setThemeSaved(false);
    setThemeError(null);
    try {
      await props.onSaveTheme({ showThinking: checked });
      setThemeSaved(true);
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : "显示思考过程保存失败");
    }
  };

  const updateCollapsed = (side: "left" | "right", collapsed: boolean) => {
    setForm((previous) => {
      const next =
        side === "left"
          ? { ...previous, leftCollapsed: collapsed }
          : { ...previous, rightCollapsed: collapsed };
      return { ...next, focusMode: next.leftCollapsed && next.rightCollapsed };
    });
  };

  return (
    <>
      <SettingsInlineRow>
        <SettingsRow label="左侧宽度" htmlFor="layout-left-width" hint="200–420px">
          <StepSlider
            id="layout-left-width"
            value={form.leftSidebarWidth}
            min={200}
            max={420}
            step={10}
            onChange={(v) => setForm((f) => ({ ...f, leftSidebarWidth: v }))}
            aria-label="左侧栏宽度"
            unit="px"
          />
        </SettingsRow>
        <SettingsRow label="右侧宽度" htmlFor="layout-right-width" hint="240–520px">
          <StepSlider
            id="layout-right-width"
            value={form.rightSidebarWidth}
            min={240}
            max={520}
            step={10}
            onChange={(v) => setForm((f) => ({ ...f, rightSidebarWidth: v }))}
            aria-label="右侧栏宽度"
            unit="px"
          />
        </SettingsRow>
      </SettingsInlineRow>

      <SettingsRow label="默认收起左侧栏" htmlFor="layout-left-collapsed">
        <Toggle
          id="layout-left-collapsed"
          checked={form.leftCollapsed}
          onChange={(checked) => updateCollapsed("left", checked)}
        />
      </SettingsRow>

      <SettingsRow label="默认收起右侧栏" htmlFor="layout-right-collapsed">
        <Toggle
          id="layout-right-collapsed"
          checked={form.rightCollapsed}
          onChange={(checked) => updateCollapsed("right", checked)}
        />
      </SettingsRow>

      <SettingsRow label="动态效果" htmlFor="layout-motion">
        <Select
          id="layout-motion"
          value={form.reducedMotion}
          onChange={(v) => setForm((f) => ({ ...f, reducedMotion: v as PreferencesDocument["layout"]["reducedMotion"] }))}
        >
          <option value="system">跟随系统</option>
          <option value="on">减少动态</option>
          <option value="off">完整动态</option>
        </Select>
      </SettingsRow>

      <SettingsRow label="主题" htmlFor="layout-theme">
        <Select
          id="layout-theme"
          value={appearance.theme}
          onChange={(v) => void handleThemeChange(v as PreferencesDocument["appearance"]["theme"])}
        >
          <option value="dark">暗色</option>
          <option value="light">亮色</option>
        </Select>
      </SettingsRow>

      <SettingsSubsection title="显示偏好">
        <SettingsRow
          label="显示工具调用卡片"
          htmlFor="toggle-show-tool-calls"
          hint="在对话中展示每次工具调用的详情"
        >
          <Toggle
            id="toggle-show-tool-calls"
            checked={appearance.showToolCalls}
            onChange={handleToggleShowToolCalls}
          />
        </SettingsRow>
        <SettingsRow
          label="显示思考过程"
          htmlFor="toggle-show-thinking"
          hint="展示模型的内部推理过程"
        >
          <Toggle
            id="toggle-show-thinking"
            checked={appearance.showThinking}
            onChange={handleToggleShowThinking}
          />
        </SettingsRow>
        <SettingsSaveFeedback
          saved={themeSaved}
          error={themeError}
          savedText="显示偏好已保存"
        />
      </SettingsSubsection>

      <SettingsSaveFeedback
        saving={props.saving}
        saved={saved}
        error={localError ?? props.lastSaveError}
      />

      <div className={styles.actions}>
        <Button variant="primary" onClick={handleSave} disabled={props.saving} loading={props.saving}>
          {props.saving ? "保存中…" : "保存布局"}
        </Button>
      </div>
    </>
  );
}
