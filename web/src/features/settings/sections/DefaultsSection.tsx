import { useState } from "react";
import type { PreferencesDocument, ModelSummary } from "../../../lib/types.js";

export interface DefaultsSectionProps {
  readonly preferences: PreferencesDocument;
  readonly models: readonly ModelSummary[];
  readonly onSave: (defaults: PreferencesDocument["defaults"]) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

export function DefaultsSection(props: DefaultsSectionProps) {
  const def = props.preferences.defaults;
  const [form, setForm] = useState(def);
  const [msg, setMsg] = useState("");

  const handleSave = async () => {
    setMsg("");
    try {
      await props.onSave(form);
      setMsg("saved");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    }
  };

  return (
    <section className="settings-section" data-testid="settings-section-defaults">
      <h2>默认对话</h2>
      <p className="settings-desc">新建 Session 时的默认行为。已有 Session 的显式设置不受影响。</p>

      <label>
        默认模型
        <select
          value={form.model ? `${form.model.providerId}:${form.model.modelId}` : ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") { setForm((f) => ({ ...f, model: null })); return; }
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
        </select>
      </label>

      <label>
        思考级别
        <select value={form.thinkingLevel} onChange={(e) => setForm((f) => ({ ...f, thinkingLevel: e.target.value as PreferencesDocument["defaults"]["thinkingLevel"] }))}>
          {(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>

      <label>
        工具模式
        <select value={form.toolMode} onChange={(e) => setForm((f) => ({ ...f, toolMode: e.target.value as PreferencesDocument["defaults"]["toolMode"] }))}>
          {(["off", "read-only", "all"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      {props.lastSaveError && <div className="save-error" role="alert">{props.lastSaveError}</div>}
      {msg === "saved" && <div className="save-ok">已保存</div>}
      {msg && msg !== "saved" && <div className="save-error">{msg}</div>}

      <button className="settings-btn primary" onClick={handleSave} disabled={props.saving} type="button">
        {props.saving ? "保存中..." : "保存默认值"}
      </button>
    </section>
  );
}