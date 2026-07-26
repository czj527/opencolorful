import { useState } from "react";
import type { AgentProfile, AgentView } from "../../../lib/types.js";
import { Badge, Button, Select, TextField } from "../../../components/ui/index.js";
import { SettingsRow, SettingsSaveFeedback } from "../widgets/index.js";
import styles from "./AgentsSection.module.css";

export interface AgentsSectionProps {
  readonly agents: readonly AgentView[];
  readonly onSaveProfile: (id: string, profile: Partial<AgentProfile>) => Promise<void>;
  readonly onArchive: (id: string) => Promise<void>;
  readonly onCreate: (type: string, name: string) => Promise<void>;
  readonly saving: boolean;
  readonly lastSaveError: string | null;
}

const TYPE_BADGE_VARIANT: Record<string, "info" | "success" | "warning" | "default"> = {
  assistant: "info",
  coding: "success",
  work: "warning",
};

const TYPE_LABEL: Record<string, string> = {
  assistant: "assistant",
  coding: "coding",
  work: "work",
};

const REPLY_STYLE_OPTIONS = ["concise", "detailed", "conversational", "formal"] as const;

function AgentTypeBadge({ type }: { readonly type: string }) {
  const variant = TYPE_BADGE_VARIANT[type] ?? "default";
  return <Badge variant={variant}>{TYPE_LABEL[type] ?? type}</Badge>;
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
  const [createMsg, setCreateMsg] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreateMsg("");
    try {
      await props.onCreate(newType, newName.trim());
      setNewName("");
      setShowCreateForm(false);
    } catch (err) {
      setCreateMsg(err instanceof Error ? err.message : "创建失败");
    }
  };

  const openEdit = (agent: AgentView) => {
    setExpandedId(agent.identity.id);
    setEditPersona(agent.profile?.persona ?? "");
    setEditPersonality(agent.profile?.personality.join(", ") ?? "");
    setEditReplyStyle(agent.profile?.replyStyle ?? "concise");
    setSaveMsg("");
  };

  const toggleExpand = (agent: AgentView) => {
    if (expandedId === agent.identity.id) {
      setExpandedId(null);
    } else {
      openEdit(agent);
    }
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
    <>
      {props.agents.length === 0 && !showCreateForm && (
        <p className={styles.emptyHint}>暂无 Agent，点击下方按钮创建第一个。</p>
      )}

      <ul className={styles.list}>
        {props.agents.map((agent) => {
          const expanded = expandedId === agent.identity.id;
          return (
            <li key={agent.identity.id} className={styles.card}>
              <div
                className={styles.cardHeader}
                onClick={() => toggleExpand(agent)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(agent);
                  }
                }}
              >
                <AgentTypeBadge type={agent.identity.type} />
                <span className={styles.agentName}>{agent.identity.name}</span>
                <span className={styles.sessionCount}>{agent.sessionCount} 会话</span>
                <span
                  className={styles.archiveWrap}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void props.onArchive(agent.identity.id)}
                    title="归档 Agent"
                    aria-label={`归档 ${agent.identity.name}`}
                  >
                    归档
                  </Button>
                </span>
              </div>

              {expanded && (
                <div className={styles.editor}>
                  <SettingsRow
                    label="Persona（人设描述）"
                    htmlFor={`agent-${agent.identity.id}-persona`}
                  >
                    <TextField
                      id={`agent-${agent.identity.id}-persona`}
                      value={editPersona}
                      onChange={setEditPersona}
                      multiline
                      rows={4}
                    />
                  </SettingsRow>

                  <SettingsRow
                    label="Personality 标签"
                    htmlFor={`agent-${agent.identity.id}-personality`}
                    hint="逗号分隔"
                  >
                    <TextField
                      id={`agent-${agent.identity.id}-personality`}
                      value={editPersonality}
                      onChange={setEditPersonality}
                      placeholder="例如: helpful, curious, precise"
                    />
                  </SettingsRow>

                  <SettingsRow label="回复风格" htmlFor={`agent-${agent.identity.id}-reply`}>
                    <Select
                      id={`agent-${agent.identity.id}-reply`}
                      value={editReplyStyle}
                      onChange={setEditReplyStyle}
                    >
                      {REPLY_STYLE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </SettingsRow>

                  <SettingsSaveFeedback
                    saved={saveMsg === "saved"}
                    error={saveMsg !== "" && saveMsg !== "saved" ? saveMsg : null}
                  />

                  <div className={styles.editorActions}>
                    <Button
                      variant="primary"
                      onClick={() => void handleSaveProfile(agent.identity.id)}
                      disabled={props.saving}
                      loading={props.saving}
                    >
                      {props.saving ? "保存中…" : "保存 Profile"}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className={styles.toggleRow}>
        <Button variant="ghost" size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
          {showCreateForm ? "取消" : "+ 新建 Agent"}
        </Button>
      </div>

      <SettingsSaveFeedback error={props.lastSaveError} />

      {showCreateForm && (
        <div className={styles.editor}>
          <SettingsRow label="类型" htmlFor="agent-new-type">
            <Select id="agent-new-type" value={newType} onChange={setNewType}>
              <option value="assistant">assistant</option>
              <option value="coding">coding</option>
              <option value="work">work</option>
            </Select>
          </SettingsRow>

          <SettingsRow label="名称" htmlFor="agent-new-name">
            <TextField
              id="agent-new-name"
              value={newName}
              onChange={setNewName}
              placeholder="Agent 名称"
            />
          </SettingsRow>

          <SettingsSaveFeedback
            error={createMsg !== "" ? createMsg : null}
          />

          <div className={styles.editorActions}>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={props.saving || !newName.trim()}
              loading={props.saving}
            >
              {props.saving ? "创建中…" : "创建 Agent"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
