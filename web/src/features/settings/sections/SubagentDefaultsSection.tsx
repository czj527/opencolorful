import { useState } from "react";
import type { ModelSummary, PreferencesDocument, SubagentPreferences } from "../../../lib/types.js";
import { Button, Select } from "../../../components/ui/index.js";
import { SettingsRow, SettingsSaveFeedback } from "../widgets/index.js";
import styles from "./SubagentDefaultsSection.module.css";

export interface SubagentDefaultsSectionProps {
  readonly preferences: PreferencesDocument;
  readonly models: readonly ModelSummary[];
  readonly onSave: (subagents: SubagentPreferences) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

/**
 * §21.3：默认设置区「Subagent 默认模型」。
 * - 第一项「继承主 Agent / 由主 Agent 选择」，对应 `null`（§10.1）；
 * - 其余选项来自已配置且可用的 Provider models；
 * - 说明「仅影响新建 Subagent」（设置变化不改变已有 Thread，§10.2）；
 * - 保存 / 失败 / 回滚反馈遵循现有 Settings UI 模式。
 */
export function SubagentDefaultsSection(props: SubagentDefaultsSectionProps) {
  const current = props.preferences.subagents?.defaultModel ?? null;
  const [form, setForm] = useState<SubagentPreferences>({ defaultModel: current });
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const currentModelValue = form.defaultModel !== null
    ? `${form.defaultModel.providerId}:${form.defaultModel.modelId}`
    : "";

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

  return (
    <div className={styles.wrap} data-testid="subagent-defaults-section">
      <SettingsRow label="Subagent 默认模型" htmlFor="subagents-default-model">
        <Select
          id="subagents-default-model"
          value={currentModelValue}
          onChange={(val) => {
            if (val === "") {
              setForm({ defaultModel: null });
              return;
            }
            const [providerId, modelId] = val.split(":");
            if (providerId && modelId) setForm({ defaultModel: { providerId, modelId } });
          }}
        >
          <option value="">继承主 Agent / 由主 Agent 选择</option>
          {props.models.map((model) => (
            <option
              key={`${model.providerId}:${model.modelId}`}
              value={`${model.providerId}:${model.modelId}`}
            >
              {model.name} ({model.providerId})
            </option>
          ))}
        </Select>
      </SettingsRow>
      <div className={styles.note}>仅影响新建 Subagent；已有 Subagent 不会中途换模型。</div>

      <SettingsSaveFeedback
        saving={props.saving}
        saved={saved}
        error={localError ?? props.lastSaveError}
      />

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={props.saving}
          loading={props.saving}
        >
          {props.saving ? "保存中…" : "保存 Subagent 默认模型"}
        </Button>
      </div>
    </div>
  );
}
