import { X } from "lucide-react";
import { useState } from "react";

import { updateLocalPrefs, useLocalPrefs } from "../data/local-prefs.js";
import type { DesktopDataSource, ModelOption, ModelRef, PreferencesView } from "../data/source.js";
import { formatErrorAdvice, toUserError } from "../errors.js";
import type { ThemeMode } from "../theme.js";
import { ProvidersSettings } from "./ProvidersSettings.js";

/** 切片 1.5 T8：设置页只保留有真实后端/本地接线的类目，无功能的占位类目不留尸体 */
export type SettingsCategory = "appearance" | "models" | "chatDisplay" | "about";

const categories: readonly { id: SettingsCategory; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "models", label: "模型与 Provider" },
  { id: "chatDisplay", label: "对话显示" },
  { id: "about", label: "关于" },
];

const descriptions: Record<SettingsCategory, string> = {
  appearance: "主题与界面动效，只影响本机显示。",
  models: "Provider 配置、凭据与全局默认模型。凭据只写入主进程 AuthStorage，不在 renderer 回显。",
  chatDisplay: "会话时间线中事件类型的显示开关，即时生效。",
  about: "版本与连接信息。",
};

const themeOptions: readonly { id: ThemeMode; label: string }[] = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

function Toggle({ checked, onChange, label }: { readonly checked: boolean; readonly onChange: (next: boolean) => void; readonly label: string }) {
  return (
    <button
      type="button"
      className={`toggle${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => { event.stopPropagation(); onChange(!checked); }}
    >
      <i />
    </button>
  );
}

/** 全局默认模型选择：数据源为 App 已加载的 models/preferences，保存走 PUT /api/settings/preferences */
function DefaultModelRow({ source, models, preferences, onChanged }: {
  readonly source: DesktopDataSource;
  readonly models: readonly ModelOption[];
  readonly preferences: PreferencesView | null;
  readonly onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = models.filter((option) => option.credentialConfigured);
  const current = preferences?.defaults.model ?? null;
  const currentKey = current === null ? "" : JSON.stringify({ providerId: current.providerId, modelId: current.modelId });
  const disabled = saving || source.updatePreferences === undefined;

  async function change(raw: string) {
    if (source.updatePreferences === undefined) return;
    const model: ModelRef | null = raw === "" ? null : JSON.parse(raw) as ModelRef;
    setSaving(true);
    setError(null);
    try {
      await source.updatePreferences({ defaults: { model } });
      onChanged();
    } catch (cause) {
      setError(formatErrorAdvice(toUserError(cause, "saveProvider")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setting-section">
      <h3>默认模型</h3>
      <div className="setting-row">
        <span className="setting-copy">
          <strong>全局默认模型</strong>
          <small>新会话缺省使用的模型；会话内仍可单独切换</small>
        </span>
        <span className="setting-control">
          {available.length === 0 ? (
            <em>暂无可选模型，先在下方配置 Provider 凭据</em>
          ) : (
            <select
              className="setting-select"
              aria-label="全局默认模型"
              value={currentKey}
              disabled={disabled}
              onChange={(event) => void change(event.target.value)}
            >
              <option value="">未设置</option>
              {available.map((option) => {
                const key = JSON.stringify({ providerId: option.providerId, modelId: option.modelId });
                return <option key={key} value={key}>{option.name}（{option.providerId}）</option>;
              })}
            </select>
          )}
        </span>
      </div>
      {current !== null && available.length > 0
        && !available.some((option) => option.providerId === current.providerId && option.modelId === current.modelId) && (
        <p className="setting-note">当前默认模型 {current.providerId}/{current.modelId} 未配置凭据或已不在列表中。</p>
      )}
      {error !== null && <p className="setting-note is-error" role="alert">{error}</p>}
    </section>
  );
}

interface SettingsModalProps {
  readonly category: SettingsCategory;
  readonly onCategory: (category: SettingsCategory) => void;
  readonly onClose: () => void;
  readonly themeMode: ThemeMode;
  readonly onThemeMode: (mode: ThemeMode) => void;
  readonly source: DesktopDataSource;
  readonly models: readonly ModelOption[];
  readonly preferences: PreferencesView | null;
  readonly onProvidersChanged: () => void;
  readonly onPreferencesChanged: () => void;
}

export function SettingsModal({ category, onCategory, onClose, themeMode, onThemeMode, source, models, preferences, onProvidersChanged, onPreferencesChanged }: SettingsModalProps) {
  const prefs = useLocalPrefs();
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <strong id="settings-title">设置</strong>
          <button type="button" className="icon-btn" aria-label="关闭设置" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <nav className="modal-nav" aria-label="设置分类">
            {categories.map(({ id, label }) => (
              <span key={id} className="modal-nav-item">
                <button type="button" className={category === id ? "is-active" : ""} onClick={() => onCategory(id)}>
                  {label}
                </button>
              </span>
            ))}
          </nav>
          <div className="modal-content">
            <header className="modal-content-head">
              <h2>{categories.find((item) => item.id === category)?.label}</h2>
              <p>{descriptions[category]}</p>
            </header>
            {category === "appearance" && (
              <>
                <section className="setting-section">
                  <h3>主题</h3>
                  <div className="setting-row">
                    <span className="setting-copy"><strong>外观</strong><small>亮 / 暗两种主题，可跟随系统</small></span>
                    <span className="segmented" role="group" aria-label="主题">
                      {themeOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={themeMode === option.id ? "is-active" : ""}
                          onClick={() => onThemeMode(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </span>
                  </div>
                </section>
                <section className="setting-section">
                  <h3>动效</h3>
                  <div className="setting-row">
                    <span className="setting-copy"><strong>减少动效</strong><small>关闭界面过渡与闪烁动画；系统级减少动效设置始终生效</small></span>
                    <span className="setting-control">
                      <Toggle checked={prefs.reduceMotion} onChange={(next) => updateLocalPrefs({ reduceMotion: next })} label="减少动效" />
                    </span>
                  </div>
                </section>
              </>
            )}
            {category === "models" && (
              <>
                <DefaultModelRow source={source} models={models} preferences={preferences} onChanged={onPreferencesChanged} />
                <ProvidersSettings source={source} onChanged={onProvidersChanged} />
              </>
            )}
            {category === "chatDisplay" && (
              <section className="setting-section">
                <h3>事件显示</h3>
                <div className="setting-row">
                  <span className="setting-copy"><strong>显示思考事件</strong><small>关闭后时间线不再展示思考过程</small></span>
                  <span className="setting-control">
                    <Toggle checked={prefs.showThinking} onChange={(next) => updateLocalPrefs({ showThinking: next })} label="显示思考事件" />
                  </span>
                </div>
                <div className="setting-row">
                  <span className="setting-copy"><strong>显示工具调用</strong><small>关闭后时间线不再展示工具调用事件</small></span>
                  <span className="setting-control">
                    <Toggle checked={prefs.showToolCalls} onChange={(next) => updateLocalPrefs({ showToolCalls: next })} label="显示工具调用" />
                  </span>
                </div>
              </section>
            )}
            {category === "about" && (
              <section className="setting-section">
                <h3>版本</h3>
                <div className="setting-row">
                  <span className="setting-copy"><strong>桌面端</strong><small>0.1.0 · Electron · React · Vite</small></span>
                </div>
                <div className="setting-row">
                  <span className="setting-copy"><strong>数据源</strong><small>{source.info.label}</small></span>
                  <span className="setting-control"><em>{source.info.connected ? "已连接" : "未连接"}</em></span>
                </div>
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
