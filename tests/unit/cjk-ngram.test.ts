import { describe, expect, it } from "vitest";

import {
  buildMemoryFtsQuery,
  buildMemorySearchText,
  cjkNgrams,
  escapeLikePattern,
  hasCjk,
  isSingleCjkQuery,
  normalizeSearchText,
} from "../../src/storage/memory/cjk-ngram.js";

describe("normalizeSearchText", () => {
  it("trims whitespace", () => {
    expect(normalizeSearchText("  记忆  ")).toBe("记忆");
  });

  it("applies NFKC normalization (full-width → half-width)", () => {
    expect(normalizeSearchText("Ｈｅｌｌｏ")).toBe("Hello");
  });

  it("handles empty input", () => {
    expect(normalizeSearchText("")).toBe("");
  });
});

describe("cjkNgrams", () => {
  it("generates 2-grams and 3-grams for CJK runs", () => {
    // “记忆系统” → 2-gram: 记忆/忆系/系统；3-gram: 记忆系/忆系统
    expect(cjkNgrams("记忆系统")).toEqual(["记忆", "忆系", "系统", "记忆系", "忆系统"]);
  });

  it("skips n-grams larger than the run", () => {
    expect(cjkNgrams("记忆")).toEqual(["记忆"]);
  });

  it("returns empty for pure latin text", () => {
    expect(cjkNgrams("hello world")).toEqual([]);
  });

  it("treats mixed text runs separately", () => {
    expect(cjkNgrams("hello世界")).toEqual(["世界"]);
  });

  it("handles Japanese kana and Korean hangul", () => {
    expect(cjkNgrams("こんにちは")).toContain("こんに");
    expect(cjkNgrams("한국어")).toContain("한국");
  });
});

describe("buildMemorySearchText", () => {
  it("keeps the original text and appends CJK n-grams", () => {
    const text = buildMemorySearchText("用户喜欢 TypeScript 记忆系统");
    expect(text).toContain("用户喜欢 TypeScript 记忆系统");
    expect(text).toContain("记忆");
    expect(text).toContain("系统");
  });

  it("dedupes repeated n-gram tokens across runs", () => {
    // 句号分隔出两个相同 CJK run，产生的 2-gram 只保留一份
    const text = buildMemorySearchText("记忆。记忆");
    expect(text.split(" ").filter((token) => token === "记忆")).toHaveLength(1);
  });

  it("joins multiple parts with spaces", () => {
    const text = buildMemorySearchText("偏好", "深色模式");
    expect(text).toContain("偏好");
    expect(text).toContain("深色模式");
  });

  it("returns empty string for empty parts", () => {
    expect(buildMemorySearchText("", "  ")).toBe("");
  });
});

describe("buildMemoryFtsQuery", () => {
  it("builds OR-joined quoted tokens", () => {
    expect(buildMemoryFtsQuery("记忆 系统")).toBe('"记忆" OR "系统"');
  });

  it("expands CJK queries into n-grams", () => {
    const query = buildMemoryFtsQuery("记忆系统");
    expect(query).toContain('"记忆"');
    expect(query).toContain('"记忆系"');
  });

  it("escapes embedded double quotes", () => {
    expect(buildMemoryFtsQuery('say "hi"')).toBe('"say" OR """hi"""');
  });

  it("returns empty string for empty query", () => {
    expect(buildMemoryFtsQuery("   ")).toBe("");
  });
});

describe("hasCjk / isSingleCjkQuery", () => {
  it("detects CJK presence", () => {
    expect(hasCjk("你好")).toBe(true);
    expect(hasCjk("hello")).toBe(false);
  });

  it("detects single CJK char queries needing LIKE fallback", () => {
    expect(isSingleCjkQuery("记")).toBe(true);
    expect(isSingleCjkQuery(" 记 ")).toBe(true);
    expect(isSingleCjkQuery("记忆")).toBe(false);
    expect(isSingleCjkQuery("a")).toBe(false);
    expect(isSingleCjkQuery("")).toBe(false);
  });
});

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards and the escape char itself", () => {
    expect(escapeLikePattern("50%_\\")).toBe("50\\%\\_\\\\");
  });

  it("leaves normal text untouched", () => {
    expect(escapeLikePattern("记忆")).toBe("记忆");
  });
});
