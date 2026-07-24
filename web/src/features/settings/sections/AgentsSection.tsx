import { useState } from "react";
import type { AgentProfile, AgentView } from "../../../lib/types.js";

export interface AgentsSectionProps {
  readonly agents: readonly AgentView[];
  readonly onSaveProfile: (id: string, profile: Partial<AgentProfile>) => Promise<void>;
  readonly onArchive: (id: string) => Promise<void>;
  readonly onCreate: (type: string, name: string) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  assistant: { bg: "rgba(74,158,255,0.15)", fg: "var(--accent)" },
  coding: { bg: "rgba(74,255,120,0.12)", fg: "var(--success)" },
  work: { bg: "rgba(255,166,74,0.15)", fg: "var(--warning)" },
};

const REPLY_STYLE_OPTIONS = ["concise", "detailed", "conversational", "formal"] as const;

function AgentTypeBadge({ type }: { readonly type: string }) {
  const colors = TYPE_COLORS[type] ?? { bg: "var(--bg-tertiary)", fg: "var(--text-secondary)" };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 10,
        background: colors.bg,
        color: colors.fg,
        textTransform: "uppercase",
        letterSpacing: "0.3px",
      }}
    >
      {type}
    </span>
  );
}

export function AgentsSection(props: AgentsSectionProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newType, setNewType] = useState("assistant");
  const [newName, setNewName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editPersona, setEditPersona] = useState("");
  const [editPersonality, setEditPersonality] = useState("");
  const [editReplyStyle, setEditReplyStyle] = useState("concise");
  const [saveMsg, setSaveMsg] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await props.onCreate(newType, newName.trim());
    setNewName("");
    setShowCreateForm(false);
  };

  const openEdit = (agent: AgentView) => {
    setExpandedId(agent.identity.id);
    setEditPersona(agent.profile?.persona ?? "");
    setEditPersonality(agent.profile?.personality.join(", ") ?? "");
    setEditReplyStyle(agent.profile?.replyStyle ?? "concise");
    setSaveMsg("");
  };

  const handleSaveProfile = async (id: string) => {
    setSaveMsg("");
    try {
      const personality = editPersonality
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await props.onSaveProfile(id, {
        persona: editPersona,
        personality,
        replyStyle: editReplyStyle,
      });
      setSaveMsg("saved");
      setExpandedId(null);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存失败");
    }
  };

  return (
    <section className="settings-section" data-testid="settings-section-agents">
      <h2>Agent 管理</h2>
      <p className="settings-desc">管理 Agent 身份、个性与回复风格。</p>

      {props.agents.length === 0 && !showCreateForm && (
        <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
          暂无 Agent，点击下方按钮创建第一个。
        </div>
      )}

      <ul className="provider-list">
        {props.agents.map((agent) => (
          <li
            key={agent.identity.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "10px 14px",
              background: "var(--bg-tertiary)",
              borderRadius: 8,
              border: "1px solid var(--border-color)",
            }}
          >
            {/* Card header */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
              onClick={() => expandedId === agent.identity.id ? setExpandedId(null) : openEdit(agent)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  expandedId === agent.identity.id ? setExpandedId(null) : openEdit(agent);
                }
              }}
            >
              <AgentTypeBadge type={agent.identity.type} />
              <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
                {agent.identity.name}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto" }}>
                {agent.sessionCount} 会话
              </span>
              <button
                type="button"
                className="settings-btn"
                style={{ padding: "3px 10px", fontSize: 12 }}
                onClick={(e) => {
                  e.stopPropagation();
                  void props.onArchive(agent.identity.id);
                }}
                title="归档 Agent"
                aria-label={`归档 ${agent.identity.name}`}
              >
                归档
              </button>
            </div>

            {/* Expanded profile editor */}
            {expandedId === agent.identity.id && (
              <div className="settings-form">
                <label>
                  Persona（人设描述）
                  <textarea
                    value={editPersona}
                    onChange={(e) => setEditPersona(e.target.value)}
                    rows={4}
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: 4,
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border-color)",
                      background: "var(--bg-tertiary)",
                      color: "var(--text-primary)",
                      fontSize: 13,
                      outline: "none",
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />
                </label>

                <label>
                  Personality 标签（逗号分隔）
                  <input
                    type="text"
                    value={editPersonality}
                    onChange={(e) => setEditPersonality(e.target.value)}
                    placeholder="例如: helpful, curious, precise"
                  />
                </label>

                <label>
                  回复风格
                  <select
                    value={editReplyStyle}
                    onChange={(e) => setEditReplyStyle(e.target.value)}
                  >
                    {REPLY_STYLE_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>

                {saveMsg === "saved" && <div className="save-ok">已保存</div>}
                {saveMsg && saveMsg !== "saved" && <div className="save-error">{saveMsg}</div>}

                <button
                  className="settings-btn primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSaveProfile(agent.identity.id);
                  }}
                  disabled={props.saving}
                  type="button"
                >
                  {props.saving ? "保存中..." : "保存 Profile"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="settings-btn"
        onClick={() => setShowCreateForm(!showCreateForm)}
        style={{ marginBottom: 12 }}
      >
        {showCreateForm ? "取消" : "+ 新建 Agent"}
      </button>

      {props.lastSaveError && <div className="save-error" role="alert">{props.lastSaveError}</div>}

      {showCreateForm && (
        <div className="settings-form">
          <label>
            类型
            <select value={newType} onChange={(e) => setNewType(e.target.value)}>
              <option value="assistant">assistant</option>
              <option value="coding">coding</option>
              <option value="work">work</option>
            </select>
          </label>

          <label>
            名称
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Agent 名称"
            />
          </label>

          <button
            className="settings-btn primary"
            onClick={handleCreate}
            disabled={props.saving || !newName.trim()}
            type="button"
          >
            {props.saving ? "创建中..." : "创建 Agent"}
          </button>
        </div>
      )}
    </section>
  );
}
