import { useState } from "react";

import type { SessionView } from "../../lib/types.js";
import { TOOL_MODES, THINKING_LEVELS, validateSessionSettings, hasSessionSettingsErrors, type SessionSettingsFormData, type SessionSettingsFormErrors } from "./session-settings.js";

interface SessionSettingsPanelProps {
  readonly session: SessionView;
  readonly onSave: (settings: Record<string, unknown>) => Promise<void>;
  readonly saving: boolean;
}

export function SessionSettingsPanel({ session, onSave, saving }: SessionSettingsPanelProps) {
  const [form, setForm] = useState<SessionSettingsFormData>({
    toolMode: (session.toolMode as SessionSettingsFormData["toolMode"]) ?? "read-only",
    workspaceCwd: session.workspaceCwd ?? "",
    workspaceConfirmed: session.workspaceConfirmed,
    thinkingLevel: (session.thinkingLevel as SessionSettingsFormData["thinkingLevel"]) ?? "medium",
  });
  const [errors, setErrors] = useState<SessionSettingsFormErrors>({});
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const validationErrors = validateSessionSettings(form);
    setErrors(validationErrors);
    if (hasSessionSettingsErrors(validationErrors)) return;

    await onSave({
      toolMode: form.toolMode,
      workspaceCwd: form.workspaceCwd,
      workspaceConfirmed: form.workspaceConfirmed,
      thinkingLevel: form.thinkingLevel,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>会话设置</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label htmlFor="tool-mode" style={{ fontSize: 12, color: "var(--text-secondary)" }}>工具模式</label>
          <select
            id="tool-mode"
            value={form.toolMode}
            onChange={(e) => setForm((prev) => ({ ...prev, toolMode: e.target.value as SessionSettingsFormData["toolMode"] }))}
            style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
          >
            {TOOL_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {errors.toolMode && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.toolMode}</div>}
        </div>

        {form.toolMode !== "off" && (
          <div>
            <label htmlFor="workspace-cwd" style={{ fontSize: 12, color: "var(--text-secondary)" }}>工作目录</label>
            <input
              id="workspace-cwd"
              type="text"
              value={form.workspaceCwd}
              onChange={(e) => setForm((prev) => ({ ...prev, workspaceCwd: e.target.value }))}
              placeholder="/path/to/workspace"
              style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
            />
            {errors.workspaceCwd && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.workspaceCwd}</div>}
          </div>
        )}

        {form.toolMode === "all" && (
          <div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.workspaceConfirmed}
                onChange={(e) => setForm((prev) => ({ ...prev, workspaceConfirmed: e.target.checked }))}
              />
              确认授权完整工具权限
            </label>
          </div>
        )}

        <div>
          <label htmlFor="thinking-level" style={{ fontSize: 12, color: "var(--text-secondary)" }}>思考级别</label>
          <select
            id="thinking-level"
            value={form.thinkingLevel}
            onChange={(e) => setForm((prev) => ({ ...prev, thinkingLevel: e.target.value as SessionSettingsFormData["thinkingLevel"] }))}
            style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>

        <button
          className="icon-button primary"
          onClick={handleSave}
          disabled={saving}
          type="button"
        >
          {saving ? "保存中..." : saved ? "✓ 已保存" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
