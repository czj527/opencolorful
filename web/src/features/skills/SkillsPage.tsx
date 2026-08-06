import { useEffect, useState, type ReactNode } from "react";
import { Boxes, FlaskConical, Package, Search, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import { SkillApiClient } from "../../lib/skill-api.js";
import { navigateToSkills, navigateToWorkspace } from "../../app/page-router.js";
import { InstalledSkillsView } from "./InstalledSkillsView.js";
import { DiscoverSkillsView } from "./DiscoverSkillsView.js";
import { SkillSourcesView } from "./SkillSourcesView.js";
import { SkillBundlesView } from "./SkillBundlesView.js";
import { SkillDiagnosticsView } from "./SkillDiagnosticsView.js";
import { SkillDevView } from "./SkillDevView.js";
import { SkillDetailView } from "./SkillDetailView.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 /skills 管理中心（plans/phase-13.md §14.4）
// 已安装 / 发现 / 来源信任 / Bundle / 诊断 / 开发态 + 详情。
// ═══════════════════════════════════════════════════════════════

export interface SkillsPageProps {
  readonly api: ApiClient;
  readonly skillApi: SkillApiClient;
}

type TabId = "installed" | "discover" | "sources" | "bundles" | "diagnostics" | "dev";

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly icon: ReactNode }> = [
  { id: "installed", label: "已安装", icon: <Boxes size={14} /> },
  { id: "discover", label: "发现", icon: <Search size={14} /> },
  { id: "sources", label: "来源信任", icon: <SlidersHorizontal size={14} /> },
  { id: "bundles", label: "Bundle", icon: <Package size={14} /> },
  { id: "diagnostics", label: "诊断", icon: <ShieldAlert size={14} /> },
  { id: "dev", label: "开发态", icon: <FlaskConical size={14} /> },
];

/** /skills/<skillRefKey> → 详情；其余 → 列表 */
function extractSkillRefKey(): string | null {
  if (typeof window === "undefined") return null;
  const clean = window.location.pathname.split("#")[0]?.split("?")[0] ?? "";
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "skills") {
    const key = segments[1];
    if (key !== undefined && key.length > 0) return decodeURIComponent(key);
  }
  return null;
}

export function SkillsPage(props: SkillsPageProps) {
  const [tab, setTab] = useState<TabId>("installed");
  const [detailKey, setDetailKey] = useState<string | null>(() => extractSkillRefKey());

  useEffect(() => {
    const sync = () => setDetailKey(extractSkillRefKey());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  if (detailKey !== null) {
    return (
      <div className={styles.page} data-page="skills">
        <div className={styles.view}>
          <SkillDetailView
            skillApi={props.skillApi}
            skillRefKey={detailKey}
            onBack={navigateToSkills}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page} data-page="skills">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={navigateToWorkspace} data-testid="skills-back">
          ← 返回聊天
        </button>
        <h1 className={styles.title}>Skill 管理中心</h1>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="Skill 管理中心视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`skills-tab-${item.id}`}
            className={tab === item.id ? styles.tabActive : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.view}>
        {tab === "installed" && (
          <InstalledSkillsView skillApi={props.skillApi} onOpenDetail={navigateToSkillsDetail} />
        )}
        {tab === "discover" && <DiscoverSkillsView skillApi={props.skillApi} />}
        {tab === "sources" && <SkillSourcesView skillApi={props.skillApi} />}
        {tab === "bundles" && <SkillBundlesView skillApi={props.skillApi} />}
        {tab === "diagnostics" && <SkillDiagnosticsView skillApi={props.skillApi} api={props.api} />}
        {tab === "dev" && <SkillDevView skillApi={props.skillApi} />}
      </div>
    </div>
  );
}

function navigateToSkillsDetail(skillRefKey: string): void {
  if (typeof window === "undefined") return;
  history.pushState({}, "", `/skills/${encodeURIComponent(skillRefKey)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
