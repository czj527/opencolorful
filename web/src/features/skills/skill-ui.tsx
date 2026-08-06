import type { ReactNode } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { EmptyState, Spinner } from "../../components/ui/index.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill 通用 UI 小块（对照 plugins/plugin-ui.tsx 模式）
// ═══════════════════════════════════════════════════════════════

export type Tone = "ok" | "warn" | "danger" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: styles.pillOk ?? "",
  warn: styles.pillWarn ?? "",
  danger: styles.pillDanger ?? "",
  muted: styles.pillMuted ?? "",
};

export function StatusPill(props: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`${styles.pill} ${TONE_CLASS[props.tone]}`}>{props.children}</span>;
}

/** Server /api/skills* 未接线或不可用时的统一降级空态。 */
export function SkillServiceUnavailable(props: { readonly detail?: string }) {
  return (
    <EmptyState
      icon={<Boxes size={28} aria-hidden="true" />}
      title="Skill 服务未就绪"
      description={
        props.detail ?? "Skill API（/api/skills）尚未接入，或 Skill 服务当前不可用。请检查组合根是否注入 skillCoreService / skillAdminService。"
      }
      action={
        <button
          type="button"
          className={styles.retryButton ?? ""}
          onClick={() => window.location.reload()}
          data-testid="skills-retry"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重试
        </button>
      }
    />
  );
}

export function LoadingBlock() {
  return (
    <div className={styles.loading ?? ""} role="status">
      <Spinner size={16} />
      正在加载…
    </div>
  );
}

export function ErrorBlock(props: { readonly message: string }) {
  return (
    <div className={styles.errorBlock} role="alert">
      {props.message}
    </div>
  );
}
