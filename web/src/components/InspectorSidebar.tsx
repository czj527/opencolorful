interface InspectorSidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

export function InspectorSidebar({
  collapsed,
  onToggle,
}: InspectorSidebarProps) {
  return (
    <aside className={`app-inspector${collapsed ? " collapsed" : ""}`} role="complementary" aria-label="详情面板">
      <div className="sidebar-header">
        <span className="sidebar-title">详情</span>
      </div>
      <div className="sidebar-content" style={{ padding: 0 }}>
        <div className="empty-state" style={{ padding: 24 }}>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>更多工具即将推出</div>
        </div>
      </div>
    </aside>
  );
}
