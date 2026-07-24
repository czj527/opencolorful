import { describe, expect, it } from "vitest";

import { getScrollBehavior, shouldAutoScroll } from "./use-chat-scroll.js";

describe("shouldAutoScroll", () => {
  it("returns true when distance from bottom is less than 48px", () => {
    expect(shouldAutoScroll(1000, 960, 800)).toBe(true);
  });

  it("returns false when user scrolled up more than 48px from bottom", () => {
    expect(shouldAutoScroll(2000, 1000, 500)).toBe(false);
  });

  it("returns true when content is smaller than container", () => {
    expect(shouldAutoScroll(300, 200, 500)).toBe(true);
  });
});

describe("getScrollBehavior", () => {
  it("returns smooth when reducedMotion is false", () => {
    expect(getScrollBehavior(false)).toBe("smooth");
  });

  it("returns instant when reducedMotion is true", () => {
    expect(getScrollBehavior(true)).toBe("instant");
  });
});