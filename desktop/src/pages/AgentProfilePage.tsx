import { useEffect, useState } from "react";

import type { DesktopDataSource, AgentProfileView, MemoryAgentSettingsView } from "../data/source.js";
import type { Agent, PinnedMemory } from "../mock-data.js";

import "./AgentProfilePage.css";

interface AgentProfilePageProps {
  readonly agent: Agent;
  /** T5：App.tsx 当前未传递 source；为保持构建通过设为可选，source 缺失时页面只读展示。
   * 主 Agent 集成时只需在 App.tsx 改为 `<AgentProfilePage agent={activeAgent} source={source} />` 即可启用编辑。 */
  readonly source?: DesktopDataSource;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "未知";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function useErrorHandler() {
  const [error, setError] = useState<string | null>(null);
  const clear = () => setError(null);
  const handle = (cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    setError(message);
  };
  return { error, clear, handle };
}

export function AgentProfilePage({ agent, source }: AgentProfilePageProps) {
  const readonly = source === undefined;

  const [profile, setProfile] = useState<AgentProfileView | null>(null);
  const [settings, setSettings] = useState<MemoryAgentSettingsView | null>(null);
  const [pinned, setPinned] = useState<PinnedMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [editName, setEditName] = useState(agent.name);
  const [editDescription, setEditDescription] = useState(agent.description);
  // T9：人设（底色）编辑——replyStyle / personality 走 updateAgentBaseColor
  // （innerSetting 不在 AgentProfileView 视图内，无法初始化，故不提供编辑）
  const [editReplyStyle, setEditReplyStyle] = useState("");
  const [editPersonality, setEditPersonality] = useState("");

  const [newPinned, setNewPinned] = useState("");

  const { error, clear, handle } = useErrorHandler();

  const loadAll = async () => {
    if (source === undefined) {
      setLoading(false);
      return;
    }
    clear();
    setLoading(true);
    try {
      const [profileData, settingsData, pinnedData] = await Promise.all([
        source.getAgentProfile(agent.id),
        source.getMemorySettings(agent.id),
        source.getMemoryData(agent.id).then((data) => data.pinned),
      ]);
      setProfile(profileData);
      setSettings(settingsData);
      setPinned([...pinnedData]);
      setEditName(profileData.name);
      setEditDescription(profileData.persona || agent.description);
      setEditReplyStyle(profileData.replyStyle);
      setEditPersonality(profileData.personality.join("，"));
    } catch (cause) {
      handle(cause, "档案加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, agent.id]);

  const saveProfile = async () => {
    if (source === undefined || profile === null) return;
    const name = editName.trim();
    const description = editDescription.trim();
    if (name === "") {
      handle(new Error("名称不能为空"), "保存失败");
      return;
    }
    clear();
    setSaving(true);
    try {
      await source.updateAgentProfile(agent.id, {
        ...(name !== profile.name ? { name } : {}),
        ...(description !== profile.persona ? { description } : {}),
      });
      await loadAll();
    } catch (cause) {
      handle(cause, "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (patch: Partial<MemoryAgentSettingsView>) => {
    if (source === undefined || settings === null) return;
    clear();
    setSaving(true);
    try {
      await source.updateMemorySettings(agent.id, patch);
      const next = await source.getMemorySettings(agent.id);
      setSettings(next);
    } catch (cause) {
      handle(cause, "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const savePersona = async () => {
    if (source === undefined || profile === null) return;
    clear();
    setSaving(true);
    try {
      // 人格标签：按中英文逗号/顿号分隔，去空白去重
      const personality = [...new Set(
        editPersonality.split(/[,，、]/).map((tag) => tag.trim()).filter((tag) => tag !== ""),
      )];
      await source.updateAgentBaseColor(agent.id, {
        replyStyle: editReplyStyle.trim(),
        personality,
      });
      await loadAll();
    } catch (cause) {
      handle(cause, "人设保存失败");
    } finally {
      setSaving(false);
    }
  };

  const addPinned = async () => {
    if (source === undefined) return;
    const content = newPinned.trim();
    if (content === "") return;
    if (content.length > 500) {
      handle(new Error("置顶记忆不能超过 500 个字符"), "添加失败");
      return;
    }
    clear();
    setSaving(true);
    try {
      await source.addPinnedMemory(agent.id, content);
      const data = await source.getMemoryData(agent.id);
      setPinned([...data.pinned]);
      setNewPinned("");
    } catch (cause) {
      handle(cause, "置顶添加失败");
    } finally {
      setSaving(false);
    }
  };

  const removePinned = async (pinnedId: string) => {
    if (source === undefined) return;
    clear();
    setSaving(true);
    try {
      await source.removePinnedMemory(agent.id, pinnedId);
      const data = await source.getMemoryData(agent.id);
      setPinned([...data.pinned]);
    } catch (cause) {
      handle(cause, "置顶删除失败");
    } finally {
      setSaving(false);
    }
  };

  const displayProfile = profile ?? {
    id: agent.id,
    name: agent.name,
    createdAt: null,
    persona: agent.description,
    personality: [],
    replyStyle: "",
    workspace: agent.workspace ?? null,
    sessionCount: 0,
    decorColor: agent.color,
  };

  return (
    <div className="page-column">
      <header className="page-head">
        <h1>助理档案</h1>
        <p>{agent.name} 的身份证、人设与记忆管理。</p>
      </header>

      {error !== null && (
        <div className="chat-error" role="alert">
          {error}
          <button type="button" className="inline-action" onClick={loadAll}>重试</button>
        </div>
      )}

      {loading && <p className="page-empty">正在加载档案…</p>}

      {!loading && (
        <>
          <section className="profile-id-card" aria-label="助理身份证">
            <span className="profile-avatar" style={{ background: agent.color }} aria-hidden="true">
              {agent.initial}
            </span>
            <div className="profile-id-copy">
              <strong>{displayProfile.name}</strong>
              <span>{displayProfile.persona || "暂无底色描述"}</span>
              <small>
                工作目录：{displayProfile.workspace ?? "未设置"}
                {displayProfile.createdAt !== null && <> · 创建于 {formatTime(displayProfile.createdAt)}</>}
                {displayProfile.sessionCount > 0 && <> · {displayProfile.sessionCount} 个会话</>}
              </small>
            </div>
          </section>

          <section className="page-section">
            <h2>基础信息</h2>
            <div className="profile-form">
              <label className="profile-field">
                <span>名称</span>
                <input
                  type="text"
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  disabled={readonly || saving}
                  maxLength={100}
                />
              </label>
              <label className="profile-field">
                <span>描述（对应底色人设）</span>
                <textarea
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  disabled={readonly || saving}
                  rows={3}
                  maxLength={500}
                />
              </label>
              <div className="profile-actions">
                {readonly ? (
                  <small className="profile-readonly-hint">数据源未接入，仅可查看。</small>
                ) : (
                  <button type="button" className="btn btn-primary" disabled={saving} onClick={saveProfile}>
                    {saving ? "保存中…" : "保存"}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="page-section">
            <h2>人设</h2>
            <div className="profile-form">
              <label className="profile-field">
                <span>回复风格</span>
                <input
                  type="text"
                  value={editReplyStyle}
                  onChange={(event) => setEditReplyStyle(event.target.value)}
                  placeholder="比如：温和简洁、先给结论"
                  disabled={readonly || saving}
                  maxLength={200}
                />
              </label>
              <label className="profile-field">
                <span>人格标签（逗号分隔）</span>
                <input
                  type="text"
                  value={editPersonality}
                  onChange={(event) => setEditPersonality(event.target.value)}
                  placeholder="比如：严谨，好奇，节制"
                  disabled={readonly || saving}
                  maxLength={300}
                />
              </label>
              <div className="profile-actions">
                {readonly ? (
                  <small className="profile-readonly-hint">数据源未接入，仅可查看。</small>
                ) : (
                  <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void savePersona()}>
                    {saving ? "保存中…" : "保存人设"}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="page-section">
            <h2>置顶记忆<small>{pinned.length}</small></h2>
            <div className="plain-list">
              {pinned.map((item) => (
                <div className="plain-list-item" key={item.id}>
                  <div className="static-row profile-pinned-row">
                    <span>{item.content}</span>
                    <small>{formatTime(item.createdAt)}</small>
                  </div>
                  {!readonly && (
                    <button
                      type="button"
                      className="icon-btn profile-delete-pin"
                      aria-label="删除"
                      title="删除"
                      disabled={saving}
                      onClick={() => void removePinned(item.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {pinned.length === 0 && <p className="page-empty">暂无置顶记忆</p>}
            </div>
            {!readonly && (
              <div className="profile-add-pinned">
                <input
                  type="text"
                  placeholder="添加一条置顶记忆…"
                  value={newPinned}
                  onChange={(event) => setNewPinned(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void addPinned(); }}
                  disabled={saving}
                  maxLength={500}
                />
                <button type="button" className="btn" disabled={saving || newPinned.trim() === ""} onClick={() => void addPinned()}>
                  添加
                </button>
              </div>
            )}
          </section>

          <section className="page-section">
            <h2>记忆设置</h2>
            {settings === null ? (
              <p className="page-empty">记忆设置加载失败</p>
            ) : (
              <div className="profile-settings">
                <div className="profile-setting-row">
                  <div className="profile-setting-copy">
                    <strong>启用记忆整理</strong>
                    <small>关闭后后台不再自动整理记忆</small>
                  </div>
                  <button
                    type="button"
                    className={`toggle${settings.enabled ? " is-on" : ""}`}
                    disabled={readonly || saving}
                    onClick={() => void saveSettings({ enabled: !settings.enabled })}
                    aria-pressed={settings.enabled}
                  >
                    <i />
                  </button>
                </div>
                <div className="profile-setting-row">
                  <div className="profile-setting-copy">
                    <strong>后台复盘</strong>
                    <small>每轮对话结束后自动判断有没有值得记住的内容，候选经每日整理审批后生效</small>
                  </div>
                  <button
                    type="button"
                    className={`toggle${settings.reviewEnabled ? " is-on" : ""}`}
                    disabled={readonly || saving}
                    onClick={() => void saveSettings({ reviewEnabled: !settings.reviewEnabled })}
                    aria-pressed={settings.reviewEnabled}
                  >
                    <i />
                  </button>
                </div>
                <label className="profile-setting-row">
                  <div className="profile-setting-copy">
                    <strong>每日整理时间</strong>
                    <small>HH:MM</small>
                  </div>
                  <input
                    type="time"
                    value={settings.dailyRunTime}
                    onChange={(event) => void saveSettings({ dailyRunTime: event.target.value })}
                    disabled={readonly || saving}
                  />
                </label>
                <label className="profile-setting-row">
                  <div className="profile-setting-copy">
                    <strong>最小空闲分钟数</strong>
                    <small>整理前需保持空闲的时长</small>
                  </div>
                  <input
                    type="number"
                    min={5}
                    max={180}
                    value={settings.minIdleMinutes}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10);
                      if (!Number.isNaN(value)) void saveSettings({ minIdleMinutes: value });
                    }}
                    disabled={readonly || saving}
                  />
                </label>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
