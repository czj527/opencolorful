import type { LayoutPreferences } from "../../lib/types.js";

export type { LayoutPreferences };

export function clampWidth(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

const REDUCED_MOTION_VALUES: readonly LayoutPreferences["reducedMotion"][] = ["system", "on", "off"];

export const DEFAULT_LAYOUT_ONLY: LayoutPreferences = {
  leftSidebarWidth: 280,
  rightSidebarWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
  focusMode: false,
  reducedMotion: "system",
};

export function mergeLayoutPreferences(
  saved: unknown,
  fallback: LayoutPreferences,
): LayoutPreferences {
  if (saved === null || typeof saved !== "object") return { ...fallback };
  const source = saved as Record<string, unknown>;
  return {
    leftSidebarWidth: clampWidth(source.leftSidebarWidth, 200, 420, fallback.leftSidebarWidth),
    rightSidebarWidth: clampWidth(source.rightSidebarWidth, 240, 520, fallback.rightSidebarWidth),
    leftCollapsed: clampBoolean(source.leftCollapsed, fallback.leftCollapsed),
    rightCollapsed: clampBoolean(source.rightCollapsed, fallback.rightCollapsed),
    focusMode: clampBoolean(source.focusMode, fallback.focusMode),
    reducedMotion:
      typeof source.reducedMotion === "string" &&
      (REDUCED_MOTION_VALUES as readonly string[]).includes(source.reducedMotion)
        ? (source.reducedMotion as LayoutPreferences["reducedMotion"])
        : fallback.reducedMotion,
  };
}