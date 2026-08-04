import { Boxes } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { navigateToPlugins } from "../../app/page-router.js";
import styles from "./plugins.module.css";

/**
 * 设置中心「插件」section 的入口内容：跳转到独立 /plugins 工作页。
 * 与 LogsSection 的「打开完整日志工作页」入口同构。
 */
export function PluginsSettingsSection() {
  return (
    <div className={styles.entryRow}>
      <span data-testid="open-plugins-page">
        <Button size="sm" onClick={navigateToPlugins}>
          <Boxes size={14} aria-hidden="true" />
          打开插件中心 →
        </Button>
      </span>
      <span className={styles.entryHint}>
        管理已安装、发现、权限、开发与来源；Agent 编辑页可绑定已启用插件。绑定与权限变更从下一 turn 生效。
      </span>
    </div>
  );
}
