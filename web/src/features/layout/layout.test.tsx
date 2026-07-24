import { describe, expect, it, vi } from "vitest";

import {
  clampWidth,
  mergeLayoutPreferences,
  DEFAULT_LAYOUT_ONLY,
  getSidebarPresentation,
  isDrawerBackdropOpen,
  resolveReducedMotion,
  withSidebarCollapsed,
  type LayoutPreferences,
} from "./layout-preferences.js";

describe("clampWidth", () => {
  it("clamps below minimum", () => {
    expect(clampWidth(50, 200, 420, 280)).toBe(200);
  });

  it("clamps above maximum", () => {
    expect(clampWidth(9999, 200, 420, 280)).toBe(420);
  });

  it("returns the value when in range", () => {
    expect(clampWidth(300, 200, 420, 280)).toBe(300);
  });

  it("returns fallback for NaN", () => {
    expect(clampWidth(Number.NaN, 200, 420, 280)).toBe(280);
  });

  it("rounds fractional values", () => {
    expect(clampWidth(300.7, 200, 420, 280)).toBe(301);
  });
});

describe("mergeLayoutPreferences", () => {
  const fallback: LayoutPreferences = {
    leftSidebarWidth: 280,
    rightSidebarWidth: 320,
    leftCollapsed: false,
    rightCollapsed: false,
    focusMode: false,
    reducedMotion: "system",
  };

  it("returns the saved layout unchanged when valid", () => {
    const saved: LayoutPreferences = {
      leftSidebarWidth: 350,
      rightSidebarWidth: 400,
      leftCollapsed: true,
      rightCollapsed: false,
      focusMode: false,
      reducedMotion: "on",
    };
    expect(mergeLayoutPreferences(saved, fallback)).toEqual(saved);
  });

  it("clamps out-of-range widths and coerces booleans from saved", () => {
    const merged = mergeLayoutPreferences(
      { leftSidebarWidth: 10 as never, rightSidebarWidth: 9999 as never, leftCollapsed: "yes" as never, rightCollapsed: false, focusMode: false, reducedMotion: "blink" as never } as LayoutPreferences,
      fallback,
    );
    expect(merged.leftSidebarWidth).toBe(200);
    expect(merged.rightSidebarWidth).toBe(520);
    expect(merged.leftCollapsed).toBe(false);
    expect(merged.reducedMotion).toBe("system");
  });

  it("returns fallback when saved is null", () => {
    expect(mergeLayoutPreferences(null as never, fallback)).toEqual(fallback);
  });
});

describe("DEFAULT_LAYOUT_ONLY", () => {
  it("provides stable reference layout constants", () => {
    expect(DEFAULT_LAYOUT_ONLY.leftSidebarWidth).toBe(280);
    expect(DEFAULT_LAYOUT_ONLY.rightSidebarWidth).toBe(320);
  });
});

describe("responsive layout state", () => {
  it("keeps narrow drawers collapsed regardless of desktop preferences", () => {
    const saved = { ...DEFAULT_LAYOUT_ONLY, leftCollapsed: false, rightCollapsed: false };
    expect(getSidebarPresentation(saved, { leftNarrow: true, rightNarrow: true })).toEqual({
      leftCollapsed: true,
      rightCollapsed: true,
    });
  });

  it("updates both collapse state and derived focus mode without losing sibling values", () => {
    const leftCollapsed = withSidebarCollapsed(DEFAULT_LAYOUT_ONLY, "left", true);
    const bothCollapsed = withSidebarCollapsed(leftCollapsed, "right", true);

    expect(bothCollapsed.leftCollapsed).toBe(true);
    expect(bothCollapsed.rightCollapsed).toBe(true);
    expect(bothCollapsed.focusMode).toBe(true);
  });

  it("honors explicit motion settings before the system preference", () => {
    expect(resolveReducedMotion("on", false)).toBe(true);
    expect(resolveReducedMotion("off", true)).toBe(false);
    expect(resolveReducedMotion("system", true)).toBe(true);
  });

  it("shows a backdrop when either responsive panel is open", () => {
    expect(isDrawerBackdropOpen(
      { leftNarrow: false, rightNarrow: true },
      { leftCollapsed: false, rightCollapsed: false },
    )).toBe(true);
    expect(isDrawerBackdropOpen(
      { leftNarrow: false, rightNarrow: true },
      { leftCollapsed: false, rightCollapsed: true },
    )).toBe(false);
  });
});
