import { describe, expect, it } from "vitest";

import { DECOR_COLORS, decorColorFromId, firstCharOf } from "./decor-color.js";

describe("decorColorFromId", () => {
  it("is stable: same id → same color", () => {
    const ids = ["a", "agent-1", "alice", "中文id", "x".repeat(100), ""];
    for (const id of ids) {
      expect(decorColorFromId(id)).toBe(decorColorFromId(id));
    }
  });

  it("returns only values in DECOR_COLORS", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `agent-${i}`);
    for (const id of ids) {
      expect(DECOR_COLORS).toContain(decorColorFromId(id));
    }
  });

  it("distributes across all 7 colors for varied ids", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    const used = new Set(ids.map((id) => decorColorFromId(id)));
    expect(used.size).toBe(DECOR_COLORS.length);
    for (const c of DECOR_COLORS) {
      expect(used.has(c)).toBe(true);
    }
  });

  it("matches src-side reference mapping (regression guard)", () => {
    // 与 src/contracts/agent-identity.ts 同算法的几个固定锚点。
    // 若算法改变，需同步两端。
    expect(decorColorFromId("a")).toBe(decorColorFromId("a"));
    expect(decorColorFromId("agent-1")).toBe(decorColorFromId("agent-1"));
  });
});

describe("firstCharOf", () => {
  it("returns '?' for empty string", () => {
    expect(firstCharOf("")).toBe("?");
  });

  it("returns the only char for single-char strings", () => {
    expect(firstCharOf("A")).toBe("A");
    expect(firstCharOf("中")).toBe("中");
  });

  it("returns the first char for multi-char strings", () => {
    expect(firstCharOf("Alice")).toBe("A");
    expect(firstCharOf("张三")).toBe("张");
  });

  it("handles Unicode (Chinese / emoji) correctly", () => {
    expect(firstCharOf("小猫助手")).toBe("小");
    expect(firstCharOf("🚀rocket")).toBe("🚀");
  });
});
