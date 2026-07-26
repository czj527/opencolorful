import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// 静态守护：layout.css 的 :root 不得重复定义颜色 token
// 颜色 token 由 themes/dark.css (:root) 和 themes/light.css ([data-theme="light"]) 独占定义
const COLOR_TOKEN_NAMES = [
  "--bg-primary",
  "--bg-secondary",
  "--bg-tertiary",
  "--text-primary",
  "--text-secondary",
  "--accent",
  "--accent-hover",
  "--border-color",
  "--danger",
  "--success",
  "--warning",
];

describe("layout.css should not define tokens (moved to styles/tokens.css)", () => {
  it("contains no :root block with custom properties", () => {
    const layoutCssPath = resolve(import.meta.dirname ?? __dirname, "../../app/layout.css");
    const css = readFileSync(layoutCssPath, "utf-8");

    // 结构令牌已迁移到 src/styles/tokens.css；layout.css 不应再定义任何 :root 令牌
    const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
    const rootBlock = rootMatch?.[1] ?? "";

    for (const token of [...COLOR_TOKEN_NAMES, "--sidebar-width", "--inspector-width", "--transition-duration"]) {
      if (rootBlock.includes(token)) {
        const lines = rootBlock.split("\n");
        for (const line of lines) {
          if (line.includes(token)) {
            expect.fail(`layout.css should not define ${token}. Found: "${line.trim()}". Tokens live in src/styles/tokens.css (structure) or themes/*.css (color).`);
          }
        }
      }
    }
    expect(true).toBe(true);
  });
});
