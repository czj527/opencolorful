import { EmptyState } from "./ui/EmptyState.js";
import { Wrench } from "lucide-react";
import styles from "./InspectorSidebar.module.css";

interface InspectorSidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

const contentClass = styles.content ?? "";
const emptyWrapClass = styles.emptyWrap ?? "";

export function InspectorSidebar({
  collapsed,
  onToggle,
}: InspectorSidebarProps) {
  return (
    <aside
      className={`app-inspector${collapsed ? " collapsed" : ""}`}
      role="complementary"
      aria-label="详情面板"
    >
      <div className="sidebar-header">
        <span className="sidebar-title">详情</span>
      </div>
      <div className={contentClass}>
        <div className={emptyWrapClass}>
          <EmptyState
            icon={<Wrench size={28} strokeWidth={1.5} aria-hidden="true" />}
            title="更多工具即将推出"
            description="此面板将承载未来的工具与详情视图"
          />
        </div>
      </div>
    </aside>
  );
}
