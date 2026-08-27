import { useState } from "react";

import type { Agent } from "../mock-data.js";
import "./AgentIdCard.css";

/** 助理状态：仅由真实运行时驱动（离线 > 运行中 > 空闲），不虚构。 */
export interface AssistantStatus {
  readonly label: string;
  readonly tone: "ok" | "busy" | "offline";
}

interface AgentIdCardProps {
  readonly agent: Agent;
  readonly status?: AssistantStatus;
  readonly onOpenProfile: () => void;
}

/**
 * 助理身份证卡（T9）：左侧照片位头像，右侧字段化基础信息（名称/编号/状态/描述）。
 * 点击卡片进入档案页（详细编辑：基础信息、底色、置顶记忆、记忆设置）。
 * 编号点击复制完整 id。只展示真实数据驱动的字段。
 */
export function AgentIdCard({ agent, status, onOpenProfile }: AgentIdCardProps) {
  const [copied, setCopied] = useState(false);

  function copyId(event: React.MouseEvent) {
    event.stopPropagation();
    void navigator.clipboard?.writeText(agent.id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  }

  return (
    <button type="button" className="agent-id-card" onClick={onOpenProfile} aria-label={`打开 ${agent.name} 的档案页`}>
      <span className="agent-id-avatar" style={{ background: agent.color }} aria-hidden="true">
        {agent.initial}
      </span>
      <span className="agent-id-fields">
        <span className="agent-id-row">
          <span className="agent-id-label">名称</span>
          <strong>{agent.name}</strong>
        </span>
        <span className="agent-id-row">
          <span className="agent-id-label">编号</span>
          <span
            className="agent-id-value agent-id-mono"
            title={copied ? "已复制" : `${agent.id}（点击复制）`}
            onClick={copyId}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === "Enter") copyId(event as unknown as React.MouseEvent); }}
          >
            {copied ? "已复制" : agent.id}
          </span>
        </span>
        {status !== undefined && (
          <span className="agent-id-row">
            <span className="agent-id-label">状态</span>
            <span className={`agent-id-status is-${status.tone}`}><i aria-hidden="true" />{status.label}</span>
          </span>
        )}
        <span className="agent-id-row">
          <span className="agent-id-label">描述</span>
          <span className="agent-id-value">{agent.description || "（暂无描述）"}</span>
        </span>
        <span className="agent-id-hint">点击查看档案与编辑</span>
      </span>
    </button>
  );
}
