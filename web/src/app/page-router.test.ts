import { describe, expect, it } from "vitest";

import { routeFromPathname, type PageRoute } from "./page-router.js";

describe("routeFromPathname", () => {
  it("routes the workspace root to workspace", () => {
    expect(routeFromPathname("/")).toBe<PageRoute>("workspace");
    expect(routeFromPathname("")).toBe<PageRoute>("workspace");
  });

  it("routes /settings to settings", () => {
    expect(routeFromPathname("/settings")).toBe<PageRoute>("settings");
  });

  it("routes nested settings paths to settings", () => {
    expect(routeFromPathname("/settings/")).toBe<PageRoute>("settings");
    expect(routeFromPathname("/settings?section=logs")).toBe<PageRoute>("settings");
    expect(routeFromPathname("/settings#layout")).toBe<PageRoute>("settings");
  });

  it("falls back to workspace for unknown paths", () => {
    expect(routeFromPathname("/unknown/deep/path")).toBe<PageRoute>("workspace");
    expect(routeFromPathname("/sessions/abc")).toBe<PageRoute>("workspace");
  });
});