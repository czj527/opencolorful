import { useEffect, useState, type ReactNode } from "react";
import { Boxes, FlaskConical, Library, Search, ShieldCheck } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import { PluginApiClient } from "../../lib/plugin-api.js";
import {
  navigateToPluginDetail,
  navigateToPlugins,
  navigateToWorkspace,
} from "../../app/page-router.js";
import { InstalledView } from "./InstalledView.js";
import { DiscoverView } from "./DiscoverView.js";
import { PermissionsView } from "./PermissionsView.js";
import { DevelopmentView } from "./DevelopmentView.js";
import { SourcesView } from "./SourcesView.js";
import { PluginDetailView } from "./PluginDetailView.js";
import styles from "./plugins.module.css";

export interface PluginsPageProps {
  readonly api: ApiClient;
  readonly pluginApi: PluginApiClient;
}

type TabId = "installed" | "discover" | "permissions" | "development" | "sources";

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly icon: ReactNode }> = [
  { id: "installed", label: "已安装", icon: <Boxes size={14} /> },
  { id: "discover", label: "发现", icon: <Search size={14} /> },
  { id: "permissions", label: "权限", icon: <ShieldCheck size={14} /> },
  { id: "development", label: "开发", icon: <FlaskConical size={14} /> },
  { id: "sources", label: "来源", icon: <Library size={14} /> },
];

/** /plugins/<pluginId> → detail；其余（含 /plugins、/plugins/）→ 列表 */
function extractPluginId(): string | null {
  if (typeof window === "undefined") return null;
  const clean = window.location.pathname.split("#")[0]?.split("?")[0] ?? "";
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "plugins") {
    const id = segments[1];
    if (id !== undefined && id.length > 0) return decodeURIComponent(id);
  }
  return null;
}

export function PluginsPage(props: PluginsPageProps) {
  const [tab, setTab] = useState<TabId>("installed");
  const [detailId, setDetailId] = useState<string | null>(() => extractPluginId());

  // 跟随浏览器前进/后退在 /plugins 与 /plugins/:id 之间切换
  useEffect(() => {
    const sync = () => setDetailId(extractPluginId());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  if (detailId !== null) {
    return (
      <div className={styles.page} data-page="plugins">
        <div className={styles.view}>
          <PluginDetailView
            pluginApi={props.pluginApi}
            pluginId={detailId}
            onBack={navigateToPlugins}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page} data-page="plugins">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={navigateToWorkspace} data-testid="plugins-back">
          ← 返回聊天
        </button>
        <h1 className={styles.title}>插件中心</h1>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="插件中心视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`plugins-tab-${item.id}`}
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
          <InstalledView pluginApi={props.pluginApi} onOpenDetail={navigateToPluginDetail} />
        )}
        {tab === "discover" && <DiscoverView pluginApi={props.pluginApi} />}
        {tab === "permissions" && (
          <PermissionsView pluginApi={props.pluginApi} api={props.api} />
        )}
        {tab === "development" && <DevelopmentView pluginApi={props.pluginApi} />}
        {tab === "sources" && <SourcesView pluginApi={props.pluginApi} />}
      </div>
    </div>
  );
}
