import { useState } from "react";
import type { PreferencesDocument } from "../../../lib/types.js";

export interface LayoutSectionProps {
  readonly preferences: PreferencesDocument;
  readonly onSave: (layout: PreferencesDocument["layout"]) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

export function LayoutSection(props: LayoutSectionProps) {
  const layout = props.preferences.layout;
  const [form, setForm] = useState(layout);
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

  const update = (f: keyof typeof form, v: number | boolean | string) => setForm((p) => ({ ...p, [f]: v }));

  return (
    <section className="settings-section" data-testid="settings-section-layout">
      <h2>界面与布局</h2>
      <p className="settings-desc">调整侧栏宽度、焦点模式与动态效果。</p>

      <div style={{ display: "flex", gap: 16 }}>
        <label style={{ flex: 1 }}>
          左侧宽度
          <input type="number" min={200} max={420} value={form.leftSidebarWidth}
            onChange={(e) => update("leftSidebarWidth", Number(e.target.value))} />
        </label>
        <label style={{ flex: 1 }}>
          右侧宽度
          <input type="number" min={240} max={520} value={form.rightSidebarWidth}
            onChange={(e) => update("rightSidebarWidth", Number(e.target.value))} />
        </label>
      </div>

      <label>
        动态效果
        <select value={form.reducedMotion} onChange={(e) => update("reducedMotion", e.target.value)}>
          <option value="system">跟随系统</option>
          <option value="on">减少动态</option>
          <option value="off">完整动态</option>
        </select>
      </label>

      {props.lastSaveError && <div className="save-error" role="alert">{props.lastSaveError}</div>}
      {msg === "saved" && <div className="save-ok">已保存</div>}
      {msg && msg !== "saved" && <div className="save-error">{msg}</div>}

      <button className="settings-btn primary" onClick={handleSave} disabled={props.saving} type="button">
        {props.saving ? "保存中..." : "保存布局"}
      </button>
    </section>
  );
}