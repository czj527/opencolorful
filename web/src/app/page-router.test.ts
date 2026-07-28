import { describe, expect, it } from "vitest";

import { resolveAgentFormExit, routeFromPathname, type PageRoute } from "./page-router.js";

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

describe("resolveAgentFormExit", () => {
  it("skips both form entries when leaving from the dirty trap", () => {
    expect(resolveAgentFormExit({ __agentFormEntry: true, __agentFormDirty: true })).toEqual({
      kind: "go",
      delta: -2,
    });
  });

  it("returns to the previous page when browser Back already reached the form base entry", () => {
    expect(resolveAgentFormExit({ __agentFormEntry: true })).toEqual({ kind: "go", delta: -1 });
  });

  it("keeps direct deep links inside the app while removing their dirty trap", () => {
    expect(resolveAgentFormExit({
      __agentFormEntry: true,
      __agentFormDirty: true,
      __agentFormDirect: true,
    })).toEqual({ kind: "go-and-replace", delta: -1 });
    expect(resolveAgentFormExit({
      __agentFormEntry: true,
      __agentFormDirect: true,
    })).toEqual({ kind: "replace" });
  });
});
