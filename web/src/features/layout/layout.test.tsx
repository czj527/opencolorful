import { describe, expect, it, vi } from "vitest";

import { clampWidth, mergeLayoutPreferences, DEFAULT_LAYOUT_ONLY, type LayoutPreferences } from "./layout-preferences.js";

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