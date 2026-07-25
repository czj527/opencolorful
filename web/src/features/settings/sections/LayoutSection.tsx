import { useState } from "react";
import type { PreferencesDocument } from "../../../lib/types.js";

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
  const [msg, setMsg] = useState("");
  const [themeMsg, setThemeMsg] = useState("");

  const handleSave = async () => {
    setMsg("");
    try {
      await props.onSave(form);
      setMsg("saved");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    }
  };

  const handleThemeChange = async (theme: PreferencesDocument["appearance"]["theme"]) => {
    setThemeMsg("");
    try {
      await props.onSaveTheme({ theme });
      setThemeMsg("saved");
    } catch (err) {
      setThemeMsg(err instanceof Error ? err.message : "主题保存失败");
    }
  };

  const handleToggleShowToolCalls = async (checked: boolean) => {
    setThemeMsg("");
    try {
      await props.onSaveTheme({ showToolCalls: checked });
      setThemeMsg("saved");
    } catch (err) {
      setThemeMsg(err instanceof Error ? err.message : "显示工具调用保存失败");
    }
  };

  const handleToggleShowThinking = async (checked: boolean) => {
    setThemeMsg("");
    try {
      await props.onSaveTheme({ showThinking: checked });
      setThemeMsg("saved");
    } catch (err) {
      setThemeMsg(err instanceof Error ? err.message : "显示思考过程保存失败");
    }
  };

  const update = (f: keyof typeof form, v: number | boolean | string) => setForm((p) => ({ ...p, [f]: v }));
  const updateCollapsed = (side: "left" | "right", collapsed: boolean) => {
    setForm((previous) => {
      const next = side === "left"
        ? { ...previous, leftCollapsed: collapsed }
        : { ...previous, rightCollapsed: collapsed };
      return { ...next, focusMode: next.leftCollapsed && next.rightCollapsed };
    });
  };

  return (
    <section className="settings-section" data-testid="settings-section-layout">
      <h2>界面与布局</h2>
      <p className="settings-desc">调整侧栏宽度、焦点模式、动态效果与显示偏好。</p>

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

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.leftCollapsed}
          onChange={(event) => updateCollapsed("left", event.target.checked)}
        />
        默认收起左侧栏
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.rightCollapsed}
          onChange={(event) => updateCollapsed("right", event.target.checked)}
        />
        默认收起右侧栏
      </label>

      <label>
        动态效果
        <select value={form.reducedMotion} onChange={(e) => update("reducedMotion", e.target.value)}>
          <option value="system">跟随系统</option>
          <option value="on">减少动态</option>
          <option value="off">完整动态</option>
        </select>
      </label>

      <label>
        主题
        <select
          value={appearance.theme}
          onChange={(e) => void handleThemeChange(e.target.value as PreferencesDocument["appearance"]["theme"])}
        >
          <option value="dark">暗色</option>
          <option value="light">亮色</option>
        </select>
      </label>

      <h3 className="settings-subsection-title">显示偏好</h3>

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={appearance.showToolCalls}
          onChange={(event) => void handleToggleShowToolCalls(event.target.checked)}
          data-testid="toggle-show-tool-calls"
        />
        显示工具调用卡片
        <span className="hint">在对话中展示每次工具调用的详情</span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={appearance.showThinking}
          onChange={(event) => void handleToggleShowThinking(event.target.checked)}
          data-testid="toggle-show-thinking"
        />
        显示思考过程
        <span className="hint">展示模型的内部推理过程</span>
      </label>

      {themeMsg === "saved" && <div className="save-ok">显示偏好已保存</div>}
      {themeMsg && themeMsg !== "saved" && <div className="save-error">{themeMsg}</div>}

      {props.lastSaveError && <div className="save-error" role="alert">{props.lastSaveError}</div>}
      {msg === "saved" && <div className="save-ok">已保存</div>}
      {msg && msg !== "saved" && <div className="save-error">{msg}</div>}

      <button className="settings-btn primary" onClick={handleSave} disabled={props.saving} type="button">
        {props.saving ? "保存中..." : "保存布局"}
      </button>
    </section>
  );
}
