import { useState } from "react";
import type { ProviderView } from "../../../lib/types.js";
import { PROVIDER_PROTOCOLS, validateProviderForm, hasProviderFormErrors, type ProviderFormData, type ProviderFormErrors } from "../../providers/provider-form.js";

export interface ProvidersSectionProps {
  readonly providers: readonly ProviderView[];
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

export function ProvidersSection(props: ProvidersSectionProps) {
  const emptyForm: ProviderFormData = {
    providerId: "", name: "", protocol: "openai-completions", baseUrl: "",
    modelId: "", modelName: "", apiKey: "", reasoning: false,
    contextWindow: 32768, maxTokens: 4096,
  };
  const [form, setForm] = useState<ProviderFormData>(emptyForm);
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async () => {
    const e = validateProviderForm(form);
    setErrors(e);
    if (hasProviderFormErrors(e)) return;
    await props.onSaveProvider(form);
    setForm(emptyForm);
    setShowForm(false);
  };

  const update = (f: keyof ProviderFormData, v: string | number | boolean) => {
    setForm((p) => ({ ...p, [f]: v }));
    if (errors[f as keyof ProviderFormErrors]) setErrors((p) => ({ ...p, [f]: undefined }));
  };

  return (
    <section className="settings-section" data-testid="settings-section-providers">
      <h2>模型与 Provider</h2>
      <p className="settings-desc">管理已配置的模型 Provider 与凭据。</p>

      <ul className="provider-list">
        {props.providers.map((p) => (
          <li key={p.providerId} className="provider-item">
            <span className="provider-name">{p.name}</span>
            <span className={`credential-badge ${p.credentialConfigured ? "ok" : "no"}`}>
              {p.credentialConfigured ? "已配置凭据" : "未配置凭据"}
            </span>
            <span className="provider-protocol">{p.protocol} · {p.models.length} 个模型</span>
          </li>
        ))}
      </ul>

      <button type="button" className="settings-btn" onClick={() => setShowForm(!showForm)}>
        {showForm ? "取消" : "+ 添加 Provider"}
      </button>

      {props.lastSaveError && <div className="save-error" role="alert">{props.lastSaveError}</div>}

      {showForm && (
        <div className="settings-form">
          <label>Provider ID <input value={form.providerId} onChange={(e) => update("providerId", e.target.value)} /></label>
          {errors.providerId && <span className="field-error">{errors.providerId}</span>}
          <label>名称 <input value={form.name} onChange={(e) => update("name", e.target.value)} /></label>
          {errors.name && <span className="field-error">{errors.name}</span>}
          <label>协议 <select value={form.protocol} onChange={(e) => update("protocol", e.target.value)}>
            {PROVIDER_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select></label>
          <label>Base URL <input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} /></label>
          {errors.baseUrl && <span className="field-error">{errors.baseUrl}</span>}
          <label>模型 ID <input value={form.modelId} onChange={(e) => update("modelId", e.target.value)} /></label>
          {errors.modelId && <span className="field-error">{errors.modelId}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1 }}>上下文窗口 <input type="number" min={1} value={form.contextWindow} onChange={(e) => update("contextWindow", Number(e.target.value))} /></label>
            <label style={{ flex: 1 }}>最大输出 <input type="number" min={1} value={form.maxTokens} onChange={(e) => update("maxTokens", Number(e.target.value))} /></label>
          </div>
          {errors.capabilities && <span className="field-error" role="alert">{errors.capabilities}</span>}
          <label className="checkbox-label">
            <input type="checkbox" checked={form.reasoning} onChange={(e) => update("reasoning", e.target.checked)} />
            支持推理（reasoning）
          </label>
          <label>API Key <input type="password" value={form.apiKey} onChange={(e) => update("apiKey", e.target.value)} autoComplete="off" /></label>
          {errors.apiKey && <span className="field-error">{errors.apiKey}</span>}
          <button className="settings-btn primary" onClick={handleSubmit} disabled={props.saving} type="button">
            {props.saving ? "保存中..." : "保存 Provider"}
          </button>
        </div>
      )}
    </section>
  );
}