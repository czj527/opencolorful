import type { Agent } from "../mock-data.js";

import "./AgentProfilePage.css";

interface AgentProfilePageProps {
  readonly agent: Agent;
}

/**
 * T0 路由 stub：助理档案页（身份证详情）。
 * T5 在此实现：基础信息编辑、人设（base-color）展示与编辑、
 * 记忆 pinned 管理与记忆设置入口（lane E 拥有本文件与样式）。
 */
export function AgentProfilePage({ agent }: AgentProfilePageProps) {
  return (
    <div className="page-column">
      <header className="page-head">
        <h1>{agent.name} 的档案</h1>
        <p>助理身份证详情页。基础信息、人设与记忆编辑将在 T5 实现。</p>
      </header>
      <section className="page-section">
        <div className="profile-stub-card">
          <span className="agent-dot profile-stub-dot" style={{ background: agent.color }} aria-hidden="true">
            {agent.initial}
          </span>
          <span className="profile-stub-copy">
            <strong>{agent.name}</strong>
            <small>{agent.description}</small>
            <small>{agent.workspace ?? "未设置工作目录"}</small>
          </span>
        </div>
      </section>
    </div>
  );
}
