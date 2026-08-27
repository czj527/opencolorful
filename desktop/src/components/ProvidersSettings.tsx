import { useCallback, useEffect, useState } from "react";

import { formatErrorAdvice, toUserError } from "../errors.js";
import type { DesktopDataSource, ProviderInput, ProviderView } from "../data/source.js";
import "./providers.css";

/** 与 web 端 provider-form.ts 的 PROVIDER_PROTOCOLS 保持一致 */
const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "pi-messages",
] as const;

type Protocol = (typeof PROVIDER_PROTOCOLS)[number];

interface FormState {
  providerId: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  modelId: string;
  modelName: string;
  apiKey: string;
  reasoning: boolean;
  contextWindow: string;
  maxTokens: string;
}

interface FormErrors {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  modelId?: string;
  contextWindow?: string;
  maxTokens?: string;
}

const EMPTY_FORM: FormState = {
  providerId: "",
  name: "",
  protocol: "openai-completions",
  baseUrl: "",
  modelId: "",
  modelName: "",
  apiKey: "",
  reasoning: false,
  contextWindow: "32768",
  maxTokens: "4096",
};

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 校验规则与文案参照 web/src/features/providers/provider-form.ts 的 validateProviderForm */
function validateForm(form: FormState): { errors: FormErrors; contextWindow: number; maxTokens: number } {
  const errors: FormErrors = {};
  const contextWindow = Number(form.contextWindow);
  const maxTokens = Number(form.maxTokens);

  if (!form.providerId.trim()) {
    errors.providerId = "Provider ID 不能为空";
  } else if (!PROVIDER_ID_RE.test(form.providerId)) {
    errors.providerId = "只能包含小写字母、数字、点、横线和下划线";
  }

  if (!form.name.trim()) errors.name = "名称不能为空";

  if (!form.baseUrl.trim()) {
    errors.baseUrl = "Base URL 不能为空";
  } else {
    try {
      const url = new URL(form.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.baseUrl = "Base URL 必须是 HTTP 或 HTTPS";
      }
    } catch {
      errors.baseUrl = "Base URL 格式无效";
    }
  }

  if (!form.modelId.trim()) errors.modelId = "模型 ID 不能为空";

  if (!Number.isInteger(contextWindow) || contextWindow < 1) {
    errors.contextWindow = "上下文窗口必须是正整数";
  } else if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    errors.maxTokens = "最大输出必须是正整数";
  } else if (maxTokens > contextWindow) {
    errors.maxTokens = "最大输出不能大于上下文窗口";
  }

  return { errors, contextWindow, maxTokens };
}

function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}

interface FieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly error?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly children: React.ReactNode;
}

function Field({ label, htmlFor, error, hint, required, children }: FieldProps) {
  return (
    <div className={`pv-field${error !== undefined ? " has-error" : ""}`}>
      <label className="pv-label" htmlFor={htmlFor}>
        {label}
        {required === true && <em>*</em>}
      </label>
      {children}
      {hint !== undefined && <p className="pv-hint">{hint}</p>}
      {error !== undefined && (
        <p className="pv-error" role="alert">{error}</p>
      )}
    </div>
  );
}

interface ProvidersSettingsProps {
  readonly source: DesktopDataSource;
  readonly onChanged: () => void;
}

export function ProvidersSettings({ source, onChanged }: ProvidersSettingsProps) {
  const [providers, setProviders] = useState<readonly ProviderView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setListError(null);
    setProviders(null);
    source.listProviders()
      .then(setProviders)
      .catch((cause: unknown) => setListError(formatErrorAdvice(toUserError(cause, "listProviders"))));
  }, [source]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const update = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const clearFieldError = (key: keyof FormErrors) => {
    if (errors[key] !== undefined) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setSaveError(null);
  };

  const startEdit = (provider: ProviderView) => {
    const first = provider.models[0];
    setForm({
      providerId: provider.providerId,
      name: provider.name,
      protocol: (PROVIDER_PROTOCOLS as readonly string[]).includes(provider.protocol)
        ? (provider.protocol as Protocol)
        : "openai-completions",
      baseUrl: provider.baseUrl,
      modelId: first?.modelId ?? "",
      modelName: first?.name ?? "",
      apiKey: "",
      reasoning: first?.reasoning ?? false,
      contextWindow: String(first?.contextWindow ?? 32768),
      maxTokens: String(first?.maxTokens ?? 4096),
    });
    setErrors({});
    setSaveError(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    const { errors: nextErrors, contextWindow, maxTokens } = validateForm(form);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;

    setSaving(true);
    setSaveError(null);
    try {
      const providerId = form.providerId.trim();
      const modelId = form.modelId.trim();
      const input: ProviderInput = {
        providerId,
        name: form.name.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        models: [{
          modelId,
          name: form.modelName.trim() || modelId,
          capabilities: { reasoning: form.reasoning, input: ["text"], contextWindow, maxTokens },
        }],
      };
      const apiKey = form.apiKey.trim();
      await source.upsertProvider(input, apiKey === "" ? undefined : apiKey);
      resetForm();
      setShowForm(false);
      loadList();
      onChanged();
    } catch (cause) {
      setSaveError(formatErrorAdvice(toUserError(cause, "saveProvider")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pv">
      {listError !== null && (
        <div className="chat-error" role="alert">
          {listError}
          <button type="button" className="inline-action" onClick={loadList}>重试</button>
        </div>
      )}
      {providers === null && listError === null && <p className="page-empty">正在加载 Provider…</p>}
      {providers !== null && providers.length === 0 && listError === null && (
        <p className="page-empty">还没有 Provider，添加一个开始对话</p>
      )}
      {providers !== null && providers.length > 0 && (
        <ul className="pv-list">
          {providers.map((provider) => (
            <li className="pv-card" key={provider.providerId}>
              <span className="pv-card-top">
                <span className="pv-name">{provider.name}</span>
                <span className={`badge ${provider.credentialConfigured ? "badge-ok" : "badge-err"}`}>
                  {provider.credentialConfigured ? "已配置凭据" : "未配置凭据"}
                </span>
                <button type="button" className="pv-edit" onClick={() => startEdit(provider)}>编辑</button>
              </span>
              <span className="pv-card-meta">{provider.protocol} · {provider.baseUrl}</span>
              <span className="pv-card-models">{provider.models.length} 个模型</span>
            </li>
          ))}
        </ul>
      )}

      <div className="pv-actions">
        <button type="button" className="btn" onClick={() => { setShowForm((v) => !v); resetForm(); }}>
          {showForm ? "取消" : "+ 添加 Provider"}
        </button>
      </div>

      {showForm && (
        <form className="pv-form" onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
          {saveError !== null && (
            <div className="chat-error" role="alert">{saveError}</div>
          )}

          <Field label="Provider ID" htmlFor="pv-id" error={errors.providerId} required>
            <input
              id="pv-id"
              className="pv-input"
              value={form.providerId}
              onChange={(event) => { update({ providerId: event.target.value }); clearFieldError("providerId"); }}
              placeholder="my-provider"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field label="名称" htmlFor="pv-name" error={errors.name} required>
            <input
              id="pv-name"
              className="pv-input"
              value={form.name}
              onChange={(event) => { update({ name: event.target.value }); clearFieldError("name"); }}
              placeholder="My Provider"
            />
          </Field>

          <Field label="协议" htmlFor="pv-protocol">
            <select
              id="pv-protocol"
              className="pv-select"
              value={form.protocol}
              onChange={(event) => update({ protocol: event.target.value as Protocol })}
            >
              {PROVIDER_PROTOCOLS.map((protocol) => (
                <option key={protocol} value={protocol}>{protocol}</option>
              ))}
            </select>
          </Field>

          <Field label="Base URL" htmlFor="pv-baseurl" error={errors.baseUrl} required>
            <input
              id="pv-baseurl"
              className="pv-input"
              value={form.baseUrl}
              onChange={(event) => { update({ baseUrl: event.target.value }); clearFieldError("baseUrl"); }}
              placeholder="http://localhost:8080/v1"
              type="url"
              spellCheck={false}
            />
          </Field>

          <div className="pv-grid">
            <Field label="模型 ID" htmlFor="pv-modelid" error={errors.modelId} required>
              <input
                id="pv-modelid"
                className="pv-input"
                value={form.modelId}
                onChange={(event) => { update({ modelId: event.target.value }); clearFieldError("modelId"); }}
                placeholder="gpt-4"
                spellCheck={false}
              />
            </Field>
            <Field label="模型显示名" htmlFor="pv-modelname">
              <input
                id="pv-modelname"
                className="pv-input"
                value={form.modelName}
                onChange={(event) => update({ modelName: event.target.value })}
                placeholder="空则用模型 ID"
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="pv-grid">
            <Field label="上下文窗口" htmlFor="pv-context" error={errors.contextWindow} required>
              <input
                id="pv-context"
                className="pv-input"
                type="number"
                min={1}
                value={form.contextWindow}
                onChange={(event) => { update({ contextWindow: event.target.value }); clearFieldError("contextWindow"); }}
                spellCheck={false}
              />
            </Field>
            <Field label="最大输出" htmlFor="pv-maxtokens" error={errors.maxTokens} required>
              <input
                id="pv-maxtokens"
                className="pv-input"
                type="number"
                min={1}
                value={form.maxTokens}
                onChange={(event) => { update({ maxTokens: event.target.value }); clearFieldError("maxTokens"); }}
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="pv-field">
            <span className="pv-label">支持推理（reasoning）</span>
            <button
              type="button"
              className={`toggle${form.reasoning ? " is-on" : ""}`}
              role="switch"
              aria-checked={form.reasoning}
              onClick={() => update({ reasoning: !form.reasoning })}
            >
              <i />
            </button>
          </div>

          <Field label="API Key" htmlFor="pv-apikey" hint="仅用于写入凭据存储，不会回显">
            <input
              id="pv-apikey"
              className="pv-input"
              type="password"
              value={form.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
              placeholder="输入 API Key（可空）"
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>

          <div className="pv-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
            >
              {saving ? "保存中…" : "保存 Provider"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
