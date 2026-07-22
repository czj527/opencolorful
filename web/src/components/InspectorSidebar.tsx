import type { SessionView } from "../lib/types.js";

interface InspectorSidebarProps {
  readonly session: SessionView | null;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

export function InspectorSidebar({ session, collapsed, onToggle }: InspectorSidebarProps) {
  if (collapsed) {
    return null;
  }

  return (
    <aside className="app-inspector" role="complementary" aria-label="会话详情">
      <div className="sidebar-header">
        <span className="sidebar-title">详情</span>
      </div>
      <div className="sidebar-content">
        {!session ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div style={{ fontSize: "13px" }}>选择会话查看详情</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>ID</div>
              <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{session.id}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>标题</div>
              <div>{session.title}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>模型</div>
              <div>{session.provider && session.model ? `${session.provider}/${session.model}` : "未设置"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>工具模式</div>
              <div>{session.toolMode}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>工作目录</div>
              <div style={{ fontSize: 12, fontFamily: "monospace" }}>{session.workspaceCwd ?? "未设置"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>思考级别</div>
              <div>{session.thinkingLevel}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>消息数</div>
              <div>{session.messages.length}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>创建时间</div>
              <div style={{ fontSize: 12 }}>{new Date(session.createdAt).toLocaleString("zh-CN")}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>更新时间</div>
              <div style={{ fontSize: 12 }}>{new Date(session.updatedAt).toLocaleString("zh-CN")}</div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
