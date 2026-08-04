import type { ReactNode } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { EmptyState, Spinner } from "../../components/ui/index.js";
import type {
  CompatibilityItemStatus,
  PluginHealth,
  PluginStatus,
} from "../../lib/plugin-types.js";
import {
  COMPATIBILITY_ITEM_LABEL,
  COMPATIBILITY_ITEM_TONE,
  PLUGIN_HEALTH_LABEL,
  PLUGIN_HEALTH_TONE,
  PLUGIN_STATUS_LABEL,
  PLUGIN_STATUS_TONE,
} from "./plugin-format.js";
import styles from "./plugins.module.css";

type Tone = "ok" | "warn" | "danger" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: styles.pillOk ?? "",
  warn: styles.pillWarn ?? "",
  danger: styles.pillDanger ?? "",
  muted: styles.pillMuted ?? "",
};

export function StatusPill(props: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`${styles.pill} ${TONE_CLASS[props.tone]}`}>{props.children}</span>;
}

export function PluginStatusPill({ status }: { readonly status: PluginStatus }) {
  return <StatusPill tone={PLUGIN_STATUS_TONE[status]}>{PLUGIN_STATUS_LABEL[status]}</StatusPill>;
}

export function PluginHealthPill({ health }: { readonly health: PluginHealth }) {
  return <StatusPill tone={PLUGIN_HEALTH_TONE[health]}>{PLUGIN_HEALTH_LABEL[health]}</StatusPill>;
}

export function CompatibilityStatusPill({ status }: { readonly status: CompatibilityItemStatus }) {
  return <StatusPill tone={COMPATIBILITY_ITEM_TONE[status]}>{COMPATIBILITY_ITEM_LABEL[status]}</StatusPill>;
}

/** Server /api/plugins* 端点未接线或不可用时的统一降级空态。 */
export function PluginServiceUnavailable(props: { readonly detail?: string }) {
  return (
    <EmptyState
      icon={<Boxes size={28} aria-hidden="true" />}
      title="插件服务未就绪"
      description={
        props.detail ?? "插件 API（/api/plugins）尚未接入，或插件服务当前不可用。请稍后重试或检查 Supervisor / Agent Server 状态。"
      }
      action={
        <button
          type="button"
          className={styles.retryButton}
          onClick={() => window.location.reload()}
          data-testid="plugins-retry"
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
    <div className={styles.loading} role="status">
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
