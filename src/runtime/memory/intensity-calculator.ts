import {
  MEMORY_ACTIVATION_DATES_CAP,
  type MemoryStrengthTier,
} from "../../contracts/memory.js";

export interface RetentionThresholds {
  readonly mediumUp: number;
  readonly mediumDown: number;
  readonly permanentUp: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function computeActivation(input: { hitDates: readonly string[]; now?: Date }): number {
  const now = input.now ?? new Date();
  const dates = new Set(input.hitDates.map((value) => value.slice(0, 10)));
  if (dates.size === 0) return 0;
  const last = [...dates].sort().at(-1);
  if (!last) return 0;
  const lastDate = new Date(`${last}T00:00:00.000Z`);
  const daysSinceLast = Math.max(0, Math.floor((utcDay(now) - utcDay(lastDate)) / DAY_MS));
  const decay = Math.max(0.3, 1 - daysSinceLast / 60);
  const score = Math.min(dates.size, MEMORY_ACTIVATION_DATES_CAP) / MEMORY_ACTIVATION_DATES_CAP * decay;
  return Math.round(clamp(score * 100));
}

export function strengthTierOf(retention: number, thresholds: RetentionThresholds): MemoryStrengthTier {
  if (retention < thresholds.mediumUp) return "short";
  if (retention < thresholds.permanentUp) return "medium";
  return "permanent";
}

export function computeRetention(input: {
  current: number;
  signals: {
    userIntent?: boolean;
    independentSessions: number;
    independentDates: number;
    consistency?: number;
    conflicts: number;
    successUse?: number;
    ageDays: number;
  };
  thresholds: RetentionThresholds;
  now?: Date;
}): { proposed: number; tier: MemoryStrengthTier; movement: "up" | "down" | "hold" } {
  const { current, signals, thresholds } = input;
  let proposed = signals.userIntent
    ? Math.max(current, 70)
    : current + 2 * signals.independentSessions + 3 * signals.independentDates
      + 5 * (signals.consistency ?? 0) + 3 * (signals.successUse ?? 0)
      - 10 * signals.conflicts - (signals.ageDays > 180 ? 2 : 0);
  proposed = clamp(proposed);
  const currentTier = strengthTierOf(current, thresholds);
  if (currentTier === "permanent" && proposed < current) proposed = current;
  let tier = strengthTierOf(proposed, thresholds);
  // 迟滞：中期降短期必须低于 mediumDown，否则保持中期档（防阈值来回跳）
  if (currentTier === "medium" && tier === "short" && proposed >= thresholds.mediumDown) {
    tier = "medium";
  }
  const movement = proposed > current ? "up" : proposed < current ? "down" : "hold";
  return { proposed, tier, movement };
}
