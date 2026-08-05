import { describe, expect, it } from "vitest";

import { MAX_SKILL_FRONTMATTER_BYTES, parseSkillDocument, parseYamlFrontmatter } from "../../../src/runtime/skills/frontmatter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 frontmatter 解析测试（plans/phase-13.md §7.1 / §18.1）
// - 正反例：无 frontmatter / 未闭合 / 大小上限 / 类型 / 注释 / 块标量；
// - 受限 YAML 子集：映射、序列、流集合、引号、注释，拒绝 tab 与重复键。
// ═══════════════════════════════════════════════════════════════

describe("parseSkillDocument（frontmatter 分隔）", () => {
  it("标准 frontmatter + 正文解析成功", () => {
    const source = "---\nname: git-workflow\ndescription: 安全 Git 流程\n---\n# 正文\n第一步。\n";
    const result = parseSkillDocument(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.frontmatter).toMatchObject({ name: "git-workflow", description: "安全 Git 流程" });
      expect(result.document.body).toBe("# 正文\n第一步。\n");
    }
  });

  it("无 frontmatter 视为 invalid（fail-closed）", () => {
    const result = parseSkillDocument("# 只有正文\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe("skill_manifest_invalid");
    }
  });

  it("frontmatter 未闭合拒绝", () => {
    const result = parseSkillDocument("---\nname: x\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe("skill_manifest_invalid");
      expect(result.reason).toContain("未闭合");
    }
  });

  it("支持 ... 作为结束分隔符", () => {
    const result = parseSkillDocument("---\nname: x\ndescription: d\n...\n正文");
    expect(result.ok).toBe(true);
  });

  it("frontmatter 超过大小上限拒绝", () => {
    const big = `name: x\ndescription: ${"a".repeat(MAX_SKILL_FRONTMATTER_BYTES)}\n`;
    const result = parseSkillDocument(`---\n${big}---\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("大小上限");
    }
  });
});

describe("受限 YAML 子集解析", () => {
  it("标量类型：字符串/布尔/数字/null", () => {
    const value = parseYamlFrontmatter("a: 1\nb: true\nc: null\nd: hello world\n");
    expect(value).toEqual({ a: 1, b: true, c: null, d: "hello world" });
  });

  it("流集合与引号字符串", () => {
    const value = parseYamlFrontmatter(
      'tools: [bash, read]\nmeta: {a: 1, b: "x y"}\nsingle: \'it\'\'s\'\ndouble: "line\\nbreak"\n',
    );
    expect(value).toEqual({ tools: ["bash", "read"], meta: { a: 1, b: "x y" }, single: "it's", double: "line\nbreak" });
  });

  it("块序列与嵌套映射", () => {
    const value = parseYamlFrontmatter("bins:\n  - git\n  - node\nmetadata:\n  requires:\n    os:\n      - linux\n      - macos\n");
    expect(value).toEqual({
      bins: ["git", "node"],
      metadata: { requires: { os: ["linux", "macos"] } },
    });
  });

  it("块标量 |（保留换行）与 >（折叠）", () => {
    const value = parseYamlFrontmatter("a: |\n  第一行\n  第二行\nb: >\n  折叠\n  成一行\n");
    expect(value["a"]).toBe("第一行\n第二行\n");
    expect(value["b"]).toBe("折叠 成一行\n");
  });

  it("注释不进入值", () => {
    const value = parseYamlFrontmatter("a: 1 # 注释\nb: x\n# 整行注释\nc: 3\n");
    expect(value).toEqual({ a: 1, b: "x", c: 3 });
  });

  it("URL 普通标量不受冒号影响", () => {
    const value = parseYamlFrontmatter("homepage: https://example.com/a:b\n");
    expect(value).toEqual({ homepage: "https://example.com/a:b" });
  });

  it("拒绝 tab 缩进", () => {
    expect(() => parseYamlFrontmatter("a:\n\tb: 1\n")).toThrow(/tab/);
  });

  it("拒绝重复键", () => {
    expect(() => parseYamlFrontmatter("a: 1\na: 2\n")).toThrow(/重复键/);
  });

  it("顶层不是映射时拒绝", () => {
    expect(() => parseYamlFrontmatter("- a\n- b\n")).toThrow(/顶层必须是键值映射/);
  });
});
