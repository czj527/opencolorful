import { useState } from "react";
import type { PreferencesDocument, ModelSummary } from "../../../lib/types.js";
import { Button, Select } from "../../../components/ui/index.js";
import { SettingsRow, SettingsSaveFeedback } from "../widgets/index.js";
import styles from "./DefaultsSection.module.css";

export interface DefaultsSectionProps {
  readonly preferences: PreferencesDocument;
  readonly models: readonly ModelSummary[];
  readonly onSave: (defaults: PreferencesDocument["defaults"]) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TOOL_MODES = ["off", "read-only"] as const;

export function DefaultsSection(props: DefaultsSectionProps) {
  const def = props.preferences.defaults;
  const [form, setForm] = useState(def);
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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

  const currentModelValue = form.model ? `${form.model.providerId}:${form.model.modelId}` : "";

  return (
    <>
      <SettingsRow label="默认模型" htmlFor="defaults-model">
        <Select
          id="defaults-model"
          value={currentModelValue}
          onChange={(val) => {
            if (val === "") {
              setForm((f) => ({ ...f, model: null }));
              return;
            }
            const [providerId, modelId] = val.split(":");
            if (providerId && modelId) setForm((f) => ({ ...f, model: { providerId, modelId } }));
          }}
        >
          <option value="">未选择</option>
          {props.models.map((m) => (
            <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>
              {m.name} ({m.providerId})
            </option>
          ))}
        </Select>
      </SettingsRow>

      <SettingsRow label="思考级别" htmlFor="defaults-thinking">
        <Select
          id="defaults-thinking"
          value={form.thinkingLevel}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              thinkingLevel: v as PreferencesDocument["defaults"]["thinkingLevel"],
            }))
          }
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
      </SettingsRow>

      <SettingsRow label="工具模式" htmlFor="defaults-toolmode">
        <Select
          id="defaults-toolmode"
          value={form.toolMode}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              toolMode: v as PreferencesDocument["defaults"]["toolMode"],
            }))
          }
        >
          {TOOL_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </SettingsRow>

      <SettingsSaveFeedback
        saving={props.saving}
        saved={saved}
        error={localError ?? props.lastSaveError}
      />

      <div className={styles.actions}>
        <Button variant="primary" onClick={handleSave} disabled={props.saving} loading={props.saving}>
          {props.saving ? "保存中…" : "保存默认值"}
        </Button>
      </div>
    </>
  );
}
