import type { SkillReadiness, SkillSelectionMode, SkillStatus, SkillTrust, SkillValidity } from "../../lib/skill-types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill 展示格式化（plans/phase-13.md §5.2 四类状态）
// ═══════════════════════════════════════════════════════════════

export const VALIDITY_LABELS: Record<SkillValidity, string> = {
  valid: "有效",
  invalid: "无效",
};

export const TRUST_LABELS: Record<SkillTrust, string> = {
  trusted: "可信",
  untrusted: "不可信",
};

export const READINESS_LABELS: Record<SkillReadiness, string> = {
  ready: "就绪",
  degraded: "降级",
  blocked: "阻断",
  incompatible: "不兼容",
};

export const SELECTION_LABELS: Record<SkillSelectionMode, string> = {
  implicit: "自动匹配",
  "explicit-only": "显式触发",
  disabled: "已停用",
  shadowed: "被遮蔽",
};

export const SELECTION_OPTIONS: readonly { readonly value: "implicit" | "explicit-only" | "disabled"; readonly label: string }[] = [
  { value: "implicit", label: "自动匹配（implicit）" },
  { value: "explicit-only", label: "显式触发（explicit-only）" },
  { value: "disabled", label: "停用（disabled）" },
];

export const LEARNING_POLICY_LABELS: Record<string, string> = {
  disabled: "disabled（禁止主动安装）",
  "ask-always": "ask-always（每次安装都确认）",
  "ask-on-risk": "ask-on-risk（高风险确认，默认）",
};

export function statusText(status: SkillStatus | undefined): string {
  if (status === undefined) return "未知";
  const parts = [
    VALIDITY_LABELS[status.validity] ?? status.validity,
    TRUST_LABELS[status.trust] ?? status.trust,
    READINESS_LABELS[status.readiness] ?? status.readiness,
    SELECTION_LABELS[status.selection] ?? status.selection,
  ];
  return parts.join(" / ");
}

export function readinessTone(readiness: SkillReadiness | undefined): "ok" | "warn" | "danger" | "muted" {
  switch (readiness) {
    case "ready":
      return "ok";
    case "degraded":
      return "warn";
    case "blocked":
    case "incompatible":
      return "danger";
    default:
      return "muted";
  }
}

export function shortHash(hash: string | null | undefined): string {
  if (hash === undefined || hash === null || hash === "") return "—";
  return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash;
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function skillRefKeyOf(ref: { skillId: string; sourceId: string; version: string }): string {
  return `${ref.skillId}@${ref.sourceId}@${ref.version}`;
}
