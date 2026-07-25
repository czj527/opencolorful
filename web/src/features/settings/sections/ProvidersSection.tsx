import { useState } from "react";
import type { ProviderView } from "../../../lib/types.js";
import { Badge, Button, Select, TextField, Toggle } from "../../../components/ui/index.js";
import {
  PROVIDER_PROTOCOLS,
  validateProviderForm,
  hasProviderFormErrors,
  type ProviderFormData,
  type ProviderFormErrors,
} from "../../providers/provider-form.js";
import { SettingsRow, SettingsInlineRow, SettingsSaveFeedback } from "../widgets/index.js";
import styles from "./ProvidersSection.module.css";

export interface ProvidersSectionProps {
  readonly providers: readonly ProviderView[];
  readonly onSaveProvider: (data: ProviderFormData) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

const EMPTY_FORM: ProviderFormData = {
  providerId: "",
  name: "",
  protocol: "openai-completions",
  baseUrl: "",
  modelId: "",
  modelName: "",
  apiKey: "",
  reasoning: false,
  contextWindow: 32768,
  maxTokens: 4096,
};

export function ProvidersSection(props: ProvidersSectionProps) {
  const [form, setForm] = useState<ProviderFormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async () => {
    const e = validateProviderForm(form);
    setErrors(e);
    if (hasProviderFormErrors(e)) return;
    await props.onSaveProvider(form);
    setForm(EMPTY_FORM);
    setShowForm(false);
  };

  const update = (f: keyof ProviderFormData, v: string | number | boolean) => {
    setForm((p) => ({ ...p, [f]: v }));
    if (errors[f as keyof ProviderFormErrors]) setErrors((p) => ({ ...p, [f as keyof ProviderFormErrors]: undefined }));
  };

  return (
    <>
      <ul className={styles.list}>
        {props.providers.map((p) => (
          <li key={p.providerId} className={styles.item}>
            <span className={styles.name}>{p.name}</span>
            <Badge variant={p.credentialConfigured ? "success" : "danger"}>
              {p.credentialConfigured ? "已配置凭据" : "未配置凭据"}
            </Badge>
            <span className={styles.protocol}>
              {p.protocol} · {p.models.length} 个模型
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.toggleRow}>
        <Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? "取消" : "+ 添加 Provider"}
        </Button>
      </div>

      <SettingsSaveFeedback error={props.lastSaveError} />

      {showForm && (
        <div className={styles.form}>
          <SettingsRow label="Provider ID" htmlFor="provider-form-id" error={errors.providerId} required>
            <TextField
              id="provider-form-id"
              value={form.providerId}
              onChange={(v) => update("providerId", v)}
              placeholder="my-provider"
            />
          </SettingsRow>

          <SettingsRow label="名称" htmlFor="provider-form-name" error={errors.name} required>
            <TextField
              id="provider-form-name"
              value={form.name}
              onChange={(v) => update("name", v)}
              placeholder="My Provider"
            />
          </SettingsRow>

          <SettingsRow label="协议" htmlFor="provider-form-protocol">
            <Select
              id="provider-form-protocol"
              value={form.protocol}
              onChange={(v) => update("protocol", v)}
            >
              {PROVIDER_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </SettingsRow>

          <SettingsRow label="Base URL" htmlFor="provider-form-baseurl" error={errors.baseUrl} required>
            <TextField
              id="provider-form-baseurl"
              value={form.baseUrl}
              onChange={(v) => update("baseUrl", v)}
              placeholder="http://localhost:8080/v1"
              type="url"
            />
          </SettingsRow>

          <SettingsRow label="模型 ID" htmlFor="provider-form-modelid" error={errors.modelId} required>
            <TextField
              id="provider-form-modelid"
              value={form.modelId}
              onChange={(v) => update("modelId", v)}
              placeholder="gpt-4"
            />
          </SettingsRow>

          <SettingsInlineRow>
            <SettingsRow label="上下文窗口" htmlFor="provider-form-context">
              <TextField
                id="provider-form-context"
                value={String(form.contextWindow)}
                onChange={(v) => update("contextWindow", Number(v))}
              />
            </SettingsRow>
            <SettingsRow label="最大输出" htmlFor="provider-form-maxtokens">
              <TextField
                id="provider-form-maxtokens"
                value={String(form.maxTokens)}
                onChange={(v) => update("maxTokens", Number(v))}
              />
            </SettingsRow>
          </SettingsInlineRow>
          {errors.capabilities !== undefined && (
            <p className={styles.fieldError} role="alert">
              {errors.capabilities}
            </p>
          )}

          <SettingsRow label="支持推理（reasoning）" htmlFor="provider-form-reasoning">
            <Toggle
              id="provider-form-reasoning"
              checked={form.reasoning}
              onChange={(checked) => update("reasoning", checked)}
            />
          </SettingsRow>

          <SettingsRow label="API Key" htmlFor="provider-form-apikey" error={errors.apiKey} hint="不会回显，仅用于写入凭据存储">
            <TextField
              id="provider-form-apikey"
              value={form.apiKey}
              onChange={(v) => update("apiKey", v)}
              placeholder="输入 API Key"
              type="password"
            />
          </SettingsRow>

          <div className={styles.actions}>
            <Button variant="primary" onClick={handleSubmit} disabled={props.saving} loading={props.saving}>
              {props.saving ? "保存中…" : "保存 Provider"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
