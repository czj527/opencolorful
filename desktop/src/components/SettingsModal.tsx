import { ChevronRight, X } from "lucide-react";
import { useState } from "react";

import type { DesktopDataSource } from "../data/source.js";
import type { ThemeMode } from "../theme.js";
import { ProvidersSettings } from "./ProvidersSettings.js";

export type SettingsCategory =
  | "general" | "models" | "agent" | "session" | "memory"
  | "subagent" | "diagnostics" | "plugins" | "security" | "about";

interface SettingRow {
  readonly label: string;
  readonly value: string;
  readonly meta?: string;
  readonly control?: "toggle" | "select" | "action";
  readonly enabled?: boolean;
}

interface SettingSection {
  readonly title: string;
  readonly rows: readonly SettingRow[];
}

const categories: readonly { id: SettingsCategory; label: string; group: string }[] = [
  { id: "general", label: "通用", group: "应用" },
  { id: "models", label: "模型与 Provider", group: "运行" },
  { id: "agent", label: "Agent", group: "运行" },
  { id: "session", label: "会话与工作区", group: "运行" },
  { id: "memory", label: "记忆", group: "能力" },
  { id: "subagent", label: "Subagent", group: "能力" },
  { id: "diagnostics", label: "日志与诊断", group: "能力" },
  { id: "plugins", label: "插件与 Skills", group: "扩展" },
  { id: "security", label: "权限与安全", group: "扩展" },
  { id: "about", label: "关于", group: "其他" },
];

const descriptions: Record<SettingsCategory, string> = {
  general: "外观、主题与界面偏好。",
  models: "Provider 配置与凭据。凭据只写入主进程 AuthStorage，不在 renderer 回显。",
  agent: "身份、人格底色和默认工作目录属于 Agent，而不是某一条会话。",
  session: "每个会话可以覆盖默认模型、工具模式和工作目录。",
  memory: "记忆整理与检索偏好；召回过程会以事件形式回到会话。",
  subagent: "临时 Subagent 的默认模型与运行上限。",
  diagnostics: "结构化日志的级别、保留与磁盘预算。",
  plugins: "插件只能贡献页面、工作台面板或设置分区，不会接管宿主导航。",
  security: "权限是会话执行的前置条件，敏感操作都会在事件中留下决定。",
  about: "当前桌面端使用本地 mock adapter，后续通过 DesktopDataSource 接入服务端。",
};

const sections: Record<SettingsCategory, readonly SettingSection[]> = {
  general: [
    { title: "显示", rows: [
      { label: "减少动效", value: "跟随系统", control: "toggle", enabled: false },
      { label: "显示思考事件", value: "开启", control: "toggle", enabled: true },
      { label: "显示工具调用", value: "开启", control: "toggle", enabled: true },
    ] },
  ],
  models: [],
  agent: [
    { title: "当前 Agent", rows: [
      { label: "身份", value: "原 · yuan", meta: "3 个会话", control: "action" },
      { label: "人格底色", value: "代码、记忆、长期计划", control: "action" },
      { label: "默认工作目录", value: "D:\\PI-study\\opencolorful", control: "action" },
    ] },
    { title: "沙箱", rows: [
      { label: "工作区访问", value: "rw", control: "select" },
      { label: "保护路径", value: "2 条", control: "action" },
    ] },
  ],
  session: [
    { title: "当前会话", rows: [
      { label: "工具模式", value: "all", meta: "需要 workspaceConfirmed", control: "select" },
      { label: "工作目录", value: "D:\\PI-study\\opencolorful", control: "action" },
      { label: "上下文用量", value: "38.4k / 128k", meta: "30%", control: "action" },
    ] },
  ],
  memory: [
    { title: "全局默认", rows: [
      { label: "记忆整理", value: "每周日 21:00", control: "toggle", enabled: true },
      { label: "检索层级", value: "摘要 → 事实 → 原文", control: "select" },
      { label: "清除当前 Agent 记忆", value: "需要再次确认", control: "action" },
    ] },
  ],
  subagent: [
    { title: "默认值", rows: [
      { label: "默认模型", value: "继承父 Agent", control: "select" },
      { label: "运行上限", value: "12 min · 40 tool calls", control: "action" },
      { label: "运行记录", value: "4 个 thread · 9 个 artifact", control: "action" },
    ] },
  ],
  diagnostics: [
    { title: "可观测性", rows: [
      { label: "诊断级别", value: "info", meta: "debug / info / warn / error", control: "select" },
      { label: "活动保留", value: "180 天", control: "select" },
      { label: "日志磁盘预算", value: "500 MB", control: "select" },
    ] },
  ],
  plugins: [
    { title: "已启用", rows: [
      { label: "Memory Studio", value: "workspace.page", control: "toggle", enabled: true },
      { label: "Desktop Workbench", value: "workbench.panel", control: "toggle", enabled: true },
      { label: "本地 Skills", value: "6 个 bundle", control: "action" },
    ] },
  ],
  security: [
    { title: "当前策略", rows: [
      { label: "工具权限", value: "all", meta: "read / write / bash", control: "select" },
      { label: "工作区确认", value: "已确认", control: "toggle", enabled: true },
      { label: "敏感凭据", value: "主进程托管", control: "action" },
    ] },
  ],
  about: [
    { title: "版本", rows: [
      { label: "桌面端", value: "0.1.0", meta: "Electron · React · Vite", control: "action" },
      { label: "协议边界", value: "renderer / backend isolated", control: "action" },
      { label: "连接状态", value: "本地 mock adapter", control: "action" },
    ] },
  ],
};

const themeOptions: readonly { id: ThemeMode; label: string }[] = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

function Toggle({ initial }: { readonly initial: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <button
      type="button"
      className={`toggle${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={(event) => { event.stopPropagation(); setOn((v) => !v); }}
    >
      <i />
    </button>
  );
}

interface SettingsModalProps {
  readonly category: SettingsCategory;
  readonly onCategory: (category: SettingsCategory) => void;
  readonly onClose: () => void;
  readonly themeMode: ThemeMode;
  readonly onThemeMode: (mode: ThemeMode) => void;
  readonly dataSourceLabel: string;
  readonly source: DesktopDataSource;
  readonly onProvidersChanged: () => void;
}

export function SettingsModal({ category, onCategory, onClose, themeMode, onThemeMode, dataSourceLabel, source, onProvidersChanged }: SettingsModalProps) {
  let lastGroup = "";
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <strong id="settings-title">设置</strong>
          <button type="button" className="icon-btn" aria-label="关闭设置" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <nav className="modal-nav" aria-label="设置分类">
            {categories.map(({ id, label, group }) => {
              const showGroup = group !== lastGroup;
              lastGroup = group;
              return (
                <span key={id} className="modal-nav-item">
                  {showGroup && <small>{group}</small>}
                  <button type="button" className={category === id ? "is-active" : ""} onClick={() => onCategory(id)}>
                    {label}
                  </button>
                </span>
              );
            })}
          </nav>
          <div className="modal-content">
            <header className="modal-content-head">
              <h2>{categories.find((item) => item.id === category)?.label}</h2>
              <p>{descriptions[category]}</p>
            </header>
            {category === "general" && (
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
            )}
            {category === "models" && (
              <ProvidersSettings source={source} onChanged={onProvidersChanged} />
            )}
            {category !== "models" && sections[category].map((section) => (
              <section className="setting-section" key={section.title}>
                <h3>{section.title}</h3>
                {category === "about" && section.title === "版本" && (
                  <div className="setting-row">
                    <span className="setting-copy"><strong>数据源</strong><small>{dataSourceLabel}</small></span>
                  </div>
                )}
                {section.rows.map((row) => (
                  <div className="setting-row" key={row.label}>
                    <span className="setting-copy"><strong>{row.label}</strong><small>{row.value}</small></span>
                    <span className="setting-control">
                      {row.meta && <em>{row.meta}</em>}
                      {row.control === "toggle" && <Toggle initial={row.enabled ?? false} />}
                      {row.control === "select" && <ChevronRight size={14} className="chev-down" />}
                      {row.control === "action" && <ChevronRight size={14} />}
                    </span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
