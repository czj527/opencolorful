import type { ReactNode } from "react";
import { EmptyState } from "./ui/EmptyState.js";
import { Wrench } from "lucide-react";
import styles from "./InspectorSidebar.module.css";

interface InspectorSidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Phase 14（§21.2）：选中的 Subagent 只读面板（右侧栏内容） */
  readonly panel?: ReactNode;
}

const contentClass = styles.content ?? "";
const emptyWrapClass = styles.emptyWrap ?? "";

export function InspectorSidebar({
  collapsed,
  onToggle,
  panel,
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
        {panel !== undefined
          ? panel
          : (
              <div className={emptyWrapClass}>
                <EmptyState
                  icon={<Wrench size={28} strokeWidth={1.5} aria-hidden="true" />}
                  title="更多工具即将推出"
                  description="此面板将承载未来的工具与详情视图"
                />
              </div>
            )}
      </div>
    </aside>
  );
}
