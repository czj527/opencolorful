import { Check, ChevronLeft, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { pickDirectory } from "../data/pick-directory.js";
import type { AgentTemplateView, DesktopDataSource, ProviderInput } from "../data/source.js";
import { toUserError } from "../errors.js";
import "./OnboardingPage.css";

export const ONBOARDING_STEPS = [
  { id: "assistant", label: "创建助理", hint: "名字与底色" },
  { id: "provider", label: "配置模型", hint: "Provider 与 API Key" },
  { id: "directory", label: "工作目录", hint: "助理读写文件的位置" },
  { id: "permissions", label: "权限说明", hint: "工具能做什么" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

interface OnboardingPageProps {
  readonly source: DesktopDataSource;
  /** 退出引导（稍后再说）；首启状态由真实数据派生，退出后下次启动仍会被判定为首启 */
  readonly onExit: () => void;
  /** 完成引导：助理已创建，进入首次对话 */
  readonly onComplete: (agentId: string) => void;
}

/* ---- Provider 预设：只填默认值，模型 ID 等高级项仍可改（onboarding 外由设置页全量管理） ---- */

interface ProviderPreset {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    key: "deepseek", label: "DeepSeek", hint: "deepseek-chat · 国内直连",
    providerId: "deepseek", baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat", modelName: "DeepSeek Chat",
    contextWindow: 65536, maxTokens: 8192,
  },
  {
    key: "moonshot", label: "Moonshot Kimi", hint: "kimi-k2 · 长上下文",
    providerId: "moonshot", baseUrl: "https://api.moonshot.cn/v1",
    modelId: "kimi-k2-0905-preview", modelName: "Kimi K2",
    contextWindow: 262144, maxTokens: 16384,
  },
  {
    key: "custom", label: "自定义", hint: "任意 OpenAI 兼容服务",
    providerId: "", baseUrl: "", modelId: "", modelName: "",
    contextWindow: 32768, maxTokens: 4096,
  },
];

/** 模板接口不可达时的兜底：保证向导可用（空白底色合法） */
const FALLBACK_TEMPLATE: AgentTemplateView = {
  key: "blank",
  label: "空白",
  description: "从零开始自定义底色",
  color: "#888888",
  baseColor: { persona: "", personality: [], replyStyle: "", innerSetting: "" },
};

/**
 * T1：四步首启向导（创建助理 → 配置模型 → 工作目录 → 权限说明）。
 * Provider 在第 2 步即保存（尽早暴露凭据错误）；助理在最后一步才创建，
 * 避免中途退出留下半成品 Agent。
 */
export function OnboardingPage({ source, onExit, onComplete }: OnboardingPageProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 第 1 步：助理
  const [templates, setTemplates] = useState<readonly AgentTemplateView[]>([FALLBACK_TEMPLATE]);
  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState("blue");

  // 第 2 步：模型
  const [presetKey, setPresetKey] = useState("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0]?.baseUrl ?? "");
  const [modelId, setModelId] = useState(PROVIDER_PRESETS[0]?.modelId ?? "");
  const [modelName, setModelName] = useState(PROVIDER_PRESETS[0]?.modelName ?? "");
  // 自定义 Provider 的 ID 在本次引导内保持稳定，避免偏好写入失败后重试留下重复 Provider。
  const customProviderId = useRef<string | null>(null);

  // 第 3 步：工作目录
  const [directory, setDirectory] = useState("");

  useEffect(() => {
    let cancelled = false;
    source.listAgentTemplates()
      .then((list) => {
        if (cancelled || list.length === 0) return;
        setTemplates(list);
      })
      .catch(() => {
        // 模板加载失败不阻塞引导：保留兜底空白模板
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const activeTemplate = templates.find((t) => t.key === templateKey) ?? templates[0] ?? FALLBACK_TEMPLATE;
  const activePreset = PROVIDER_PRESETS.find((p) => p.key === presetKey) ?? PROVIDER_PRESETS[0]!;

  function applyPreset(key: string) {
    setPresetKey(key);
    if (key !== "custom") customProviderId.current = null;
    const preset = PROVIDER_PRESETS.find((p) => p.key === key);
    if (preset !== undefined) {
      if (preset.key !== "custom") {
        setBaseUrl(preset.baseUrl);
        setModelId(preset.modelId);
      }
      // 自定义也要清显示名：否则残留上一预设的 modelName（真链实测把自定义模型标成
      // "DeepSeek Chat"，2026-09-01 A4 PROV 真链发现）
      setModelName(preset.modelName);
    }
  }

  async function pickWorkingDirectory() {
    const picked = await pickDirectory().catch(() => null);
    if (picked !== null) setDirectory(picked);
  }

  async function saveProviderAndNext() {
    const key = apiKey.trim();
    const url = baseUrl.trim();
    const model = modelId.trim();
    if (key === "") { setError("请粘贴 API Key"); return; }
    if (!/^https?:\/\//.test(url)) { setError("Base URL 需以 http(s):// 开头"); return; }
    if (model === "") { setError("请填写模型 ID"); return; }

    setBusy(true);
    setError(null);
    try {
      const isCustom = activePreset.key === "custom";
      const providerId = isCustom
        ? (customProviderId.current ?? `custom-${Date.now().toString(36)}`)
        : activePreset.providerId;
      if (isCustom) customProviderId.current = providerId;
      const input: ProviderInput = {
        providerId,
        name: isCustom ? (modelName.trim() || "自定义 Provider") : activePreset.label,
        protocol: "openai-completions",
        baseUrl: url,
        models: [{
          modelId: model,
          name: modelName.trim() || model,
          capabilities: {
            reasoning: false,
            input: ["text"],
            contextWindow: activePreset.contextWindow,
            maxTokens: activePreset.maxTokens,
          },
        }],
      };
      await source.upsertProvider(input, key);
      // The model the user just configured is an explicit onboarding choice.
      // Persist it as the primary default so "完成，开始对话" remains a closed loop
      // now that the Desktop no longer guesses the first credentialed model.
      await source.updatePreferences({ defaults: { model: { providerId, modelId: model } } });
      setStep(2);
    } catch (cause) {
      setError(toUserError(cause, "saveProvider").message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    const trimmedName = name.trim();
    if (trimmedName === "") { setStep(0); setError("先给助理起个名字"); return; }
    setBusy(true);
    setError(null);
    try {
      const agent = await source.createAgent({
        name: trimmedName,
        baseColor: activeTemplate.baseColor,
        defaultCwd: directory.trim() === "" ? null : directory.trim(),
      });
      onComplete(agent.id);
    } catch (cause) {
      setError(toUserError(cause, "createAgent").message);
      setBusy(false);
    }
  }

  function goNext() {
    setError(null);
    if (step === 0) {
      if (name.trim() === "") { setError("先给助理起个名字"); return; }
      setStep(1);
    } else if (step === 1) {
      void saveProviderAndNext();
    } else if (step === 2) {
      setStep(3);
    }
  }

  return (
    <div className="onboarding">
      <aside className="onboarding-rail">
        <span className="onboarding-brand">初次设置</span>
        <ol className="onboarding-steps">
          {ONBOARDING_STEPS.map((item, index) => (
            <li
              key={item.id}
              className={index === step ? "is-current" : index < step ? "is-done" : ""}
            >
              <span className="onboarding-step-no" aria-hidden="true">
                {index < step ? <Check size={11} /> : index + 1}
              </span>
              <span className="onboarding-step-copy">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </li>
          ))}
        </ol>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-card">
          {step === 0 && (
            <>
              <h1>给你的助理起个名字</h1>
              <p>再选一种底色——它决定助理的语气与相处方式，之后随时可改。</p>
              <label className="onboarding-field">
                <span>名字</span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="比如：原"
                  maxLength={100}
                  autoFocus
                />
              </label>
              <div className="template-grid" role="radiogroup" aria-label="底色模板">
                {templates.map((template) => (
                  <button
                    key={template.key}
                    type="button"
                    role="radio"
                    aria-checked={template.key === templateKey}
                    className={`template-card${template.key === templateKey ? " is-active" : ""}`}
                    onClick={() => setTemplateKey(template.key)}
                  >
                    <span className="template-swatch" style={{ background: template.color }} aria-hidden="true" />
                    <strong>{template.label}</strong>
                    <small>{template.description}</small>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1>接入模型</h1>
              <p>助理靠模型思考。选一个服务商，粘贴 API Key 即可；Key 只保存在本机，不会上传。</p>
              <div className="preset-row" role="radiogroup" aria-label="服务商预设">
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    role="radio"
                    aria-checked={preset.key === presetKey}
                    className={`preset-card${preset.key === presetKey ? " is-active" : ""}`}
                    onClick={() => applyPreset(preset.key)}
                  >
                    <strong>{preset.label}</strong>
                    <small>{preset.hint}</small>
                  </button>
                ))}
              </div>
              <label className="onboarding-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </label>
              <details className="onboarding-advanced">
                <summary>高级设置（Base URL / 模型）</summary>
                <label className="onboarding-field">
                  <span>Base URL</span>
                  <input type="text" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
                </label>
                <label className="onboarding-field">
                  <span>模型 ID</span>
                  <input type="text" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="deepseek-chat" />
                </label>
                <label className="onboarding-field">
                  <span>模型显示名（可选）</span>
                  <input type="text" value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder={modelId || "模型"} />
                </label>
              </details>
            </>
          )}

          {step === 2 && (
            <>
              <h1>选一个工作目录</h1>
              <p>助理在这个目录里读取和写入文件。现在不选也可以，之后随时在助理档案里设置。</p>
              <div className="directory-row">
                <input
                  type="text"
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder="例如 D:\Projects\notes"
                />
                <button type="button" className="btn" onClick={() => void pickWorkingDirectory()}>
                  <FolderOpen size={14} />
                  浏览…
                </button>
              </div>
              {directory.trim() === "" && (
                <p className="onboarding-note">暂不设置：助理仍可对话，只是暂时没有文件工作区。</p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <h1>它能做什么、不能做什么</h1>
              <ul className="permission-list">
                <li>
                  <strong>默认只读。</strong>
                  助理可以读取工作目录里的文件来理解上下文，不会改动任何内容。
                </li>
                <li>
                  <strong>完全模式需你确认。</strong>
                  切换到完全模式后，助理可以修改文件、执行命令；首次写入前会向你确认，会话中随时可切回只读。
                </li>
                <li>
                  <strong>全程可审计。</strong>
                  每一次工具调用都记录在「日志」页，随时可以回看。
                </li>
                <li>
                  <strong>记忆可见可改。</strong>
                  助理会记住你确认过的信息；在助理档案页可以查看、置顶和纠正。
                </li>
              </ul>
            </>
          )}

          {error !== null && <div className="chat-error" role="alert">{error}</div>}

          <div className="onboarding-footer">
            <button type="button" className="btn" onClick={onExit} disabled={busy}>稍后再说</button>
            <span className="onboarding-footer-gap" />
            {step > 0 && (
              <button type="button" className="btn" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy}>
                <ChevronLeft size={14} />
                上一步
              </button>
            )}
            {step < 3 ? (
              <button type="button" className="btn btn-primary" onClick={goNext} disabled={busy}>
                {busy ? "请稍候…" : "下一步"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void finish()} disabled={busy}>
                {busy ? "正在创建…" : "完成，开始对话"}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
