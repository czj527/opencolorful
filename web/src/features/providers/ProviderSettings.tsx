import { useState } from "react";

import type { ProviderView } from "../../lib/types.js";
import { PROVIDER_PROTOCOLS, validateProviderForm, hasProviderFormErrors, type ProviderFormData, type ProviderFormErrors } from "./provider-form.js";

interface ProviderSettingsProps {
  readonly providers: ProviderView[];
  readonly onSave: (data: ProviderFormData) => Promise<void>;
  readonly saving: boolean;
}

export function ProviderSettings({ providers, onSave, saving }: ProviderSettingsProps) {
  const [form, setForm] = useState<ProviderFormData>({
    providerId: "",
    name: "",
    protocol: "openai-completions",
    baseUrl: "",
    modelId: "",
    modelName: "",
    apiKey: "",
  });
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async () => {
    const validationErrors = validateProviderForm(form);
    setErrors(validationErrors);
    if (hasProviderFormErrors(validationErrors)) return;

    await onSave(form);
    setForm({ providerId: "", name: "", protocol: "openai-completions", baseUrl: "", modelId: "", modelName: "", apiKey: "" });
    setShowForm(false);
  };

  const update = (field: keyof ProviderFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof ProviderFormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Provider 配置</span>
        <button
          className="icon-button"
          onClick={() => setShowForm(!showForm)}
          type="button"
        >
          {showForm ? "取消" : "+ 添加"}
        </button>
      </div>

      {providers.map((p) => (
        <div key={p.providerId} style={{ padding: "8px 0", borderBottom: "1px solid var(--border-color)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 500 }}>{p.name}</span>
            <span style={{ fontSize: 12, color: p.credentialConfigured ? "var(--success)" : "var(--danger)" }}>
              {p.credentialConfigured ? "✓ 已配置凭据" : "✗ 未配置凭据"}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {p.protocol} · {p.models.length} 个模型
          </div>
        </div>
      ))}

      {showForm && (
        <div style={{ marginTop: 12, padding: 12, background: "var(--bg-tertiary)", borderRadius: 6 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <label htmlFor="provider-id" style={{ fontSize: 12, color: "var(--text-secondary)" }}>Provider ID</label>
              <input
                id="provider-id"
                type="text"
                value={form.providerId}
                onChange={(e) => update("providerId", e.target.value)}
                placeholder="my-provider"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              />
              {errors.providerId && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.providerId}</div>}
            </div>

            <div>
              <label htmlFor="provider-name" style={{ fontSize: 12, color: "var(--text-secondary)" }}>名称</label>
              <input
                id="provider-name"
                type="text"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="My Provider"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              />
              {errors.name && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.name}</div>}
            </div>

            <div>
              <label htmlFor="provider-protocol" style={{ fontSize: 12, color: "var(--text-secondary)" }}>协议</label>
              <select
                id="provider-protocol"
                value={form.protocol}
                onChange={(e) => update("protocol", e.target.value)}
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              >
                {PROVIDER_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="provider-baseurl" style={{ fontSize: 12, color: "var(--text-secondary)" }}>Base URL</label>
              <input
                id="provider-baseurl"
                type="text"
                value={form.baseUrl}
                onChange={(e) => update("baseUrl", e.target.value)}
                placeholder="http://localhost:8080/v1"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              />
              {errors.baseUrl && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.baseUrl}</div>}
            </div>

            <div>
              <label htmlFor="provider-model" style={{ fontSize: 12, color: "var(--text-secondary)" }}>模型 ID</label>
              <input
                id="provider-model"
                type="text"
                value={form.modelId}
                onChange={(e) => update("modelId", e.target.value)}
                placeholder="gpt-4"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              />
              {errors.modelId && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.modelId}</div>}
            </div>

            <div>
              <label htmlFor="provider-apikey" style={{ fontSize: 12, color: "var(--text-secondary)" }}>API Key</label>
              <input
                id="provider-apikey"
                type="password"
                value={form.apiKey}
                onChange={(e) => update("apiKey", e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                style={{ width: "100%", padding: "4px 8px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }}
              />
              {errors.apiKey && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 2 }}>{errors.apiKey}</div>}
            </div>

            <button
              className="icon-button primary"
              onClick={handleSubmit}
              disabled={saving}
              type="button"
            >
              {saving ? "保存中..." : "保存 Provider"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
