import { Boxes } from "lucide-react";
import { Button } from "../../../components/ui/index.js";
import { navigateToSkills } from "../../../app/page-router.js";
import styles from "./LogsSection.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 设置 → 技能入口（plans/phase-13.md §14.4）
// Skill 管理中心是独立页面（/skills），设置页提供入口按钮。
// ═══════════════════════════════════════════════════════════════

export function SkillsSettingsSection() {
  return (
    <div className={styles.container ?? ""}>
      <p className={styles.description ?? ""}>
        Skill 决定 Agent 怎样做事。在 Skill 管理中心可以查看已安装 Skill、搜索与检查来源、
        管理来源信任与 Bundle、查看诊断与开发态（Linked Source）。安装与风险确认发生在聊天会话内。
      </p>
      <Button size="sm" onClick={navigateToSkills} data-testid="open-skills-center">
        <Boxes size={13} aria-hidden="true" />
        打开 Skill 管理中心
      </Button>
    </div>
  );
}
