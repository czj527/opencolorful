import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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

/** ISO 时间 → 本地 HH:mm；解析失败返回空串（调用方自定降级文案） */
function formatCheckTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

/** G2 T2：设置页"版本更新"区——检查/下载/重启安装三态操作 */
function UpdateSection({ state }: { readonly state: DesktopUpdateState }) {
  let title: string;
  let note: string | null = null;
  let action: ReactNode = null;
  let progress: ReactNode = null;

  switch (state.status) {
    case "unsupported":
      title = "开发模式不提供更新检查";
      note = "打包安装的正式版本支持应用内更新";
      break;
    case "idle":
      title = "检查更新";
      note = `当前版本 v${state.currentVersion}`;
      action = <button type="button" className="btn" onClick={() => void window.desktopUpdate?.check()}>检查更新</button>;
      break;
    case "checking":
      title = "检查更新";
      note = `当前版本 v${state.currentVersion}`;
      action = <button type="button" className="btn" disabled>检查中…</button>;
      break;
    case "none": {
      title = "已是最新版本";
      const checkedAtText = state.checkedAt === null ? "" : formatCheckTime(state.checkedAt);
      note = checkedAtText === "" ? null : `上次检查 ${checkedAtText}`;
      action = <button type="button" className="btn" onClick={() => void window.desktopUpdate?.check()}>重新检查</button>;
      break;
    }
    case "available":
      title = `发现新版本 v${state.newVersion ?? ""}`;
      note = `当前版本 v${state.currentVersion}`;
      action = <button type="button" className="btn btn-primary" onClick={() => void window.desktopUpdate?.download()}>下载更新</button>;
      break;
    case "downloading":
      title = `正在下载 v${state.newVersion ?? ""}`;
      action = <button type="button" className="btn" disabled>下载中…</button>;
      progress = (
        <div className="setting-note update-progress">
          <div
            className="update-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.progressPercent ?? 0}
            aria-label="更新下载进度"
          >
            <div className="update-progress-fill" style={{ width: `${state.progressPercent ?? 0}%` }} />
          </div>
          <span>{state.progressPercent ?? 0}%</span>
        </div>
      );
      break;
    case "downloaded":
      title = `v${state.newVersion ?? ""} 已就绪`;
      note = "重启应用完成安装";
      action = <button type="button" className="btn btn-primary" onClick={() => window.desktopUpdate?.install()}>重启安装</button>;
      break;
    case "error":
      title = "检查更新失败";
      note = state.message;
      action = <button type="button" className="btn" onClick={() => void window.desktopUpdate?.check()}>重试</button>;
      break;
  }

  return (
    <section className="setting-section">
      <h3>版本更新</h3>
      <div className="setting-row">
        <span className="setting-copy">
          <strong>{title}</strong>
          {note !== null && <small>{note}</small>}
        </span>
        <span className="setting-control">{action}</span>
      </div>
      {progress}
    </section>
  );
}

export function SettingsModal({ category, onCategory, onClose, themeMode, onThemeMode, source, models, preferences, onProvidersChanged, onPreferencesChanged }: SettingsModalProps) {
  const prefs = useLocalPrefs();
  // G2 T2：更新状态（无桥=浏览器 dev，保持 null → 版本区显示 dev、不渲染更新区）
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);

  // 进入"关于"类目时拉取一次状态并订阅变化；卸载/切类目时取消订阅
  useEffect(() => {
    const bridge = window.desktopUpdate;
    if (bridge === undefined || category !== "about") return;
    let cancelled = false;
    void bridge.getState().then((next) => { if (!cancelled) setUpdateState(next); }).catch(() => undefined);
    const unsubscribe = bridge.onStateChanged((next) => setUpdateState(next));
    return () => { cancelled = true; unsubscribe(); };
  }, [category]);
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
              <>
                <section className="setting-section">
                  <h3>版本</h3>
                  <div className="setting-row">
                    <span className="setting-copy">
                      <strong>桌面端</strong>
                      {/* 无桥（浏览器 dev）显示 dev；有桥显示主进程上报的真实版本 */}
                      <small>{window.desktopUpdate === undefined ? "dev" : `${updateState?.currentVersion ?? "dev"} · Electron · React · Vite`}</small>
                    </span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-copy"><strong>数据源</strong><small>{source.info.label}</small></span>
                    <span className="setting-control"><em>{source.info.connected ? "已连接" : "未连接"}</em></span>
                  </div>
                </section>
                {window.desktopUpdate !== undefined && updateState !== null && <UpdateSection state={updateState} />}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
