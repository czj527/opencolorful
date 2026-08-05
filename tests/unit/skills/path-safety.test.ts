import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SkillPathError, assertSafeRelativeEntry, canonicalPathSync, isPathWithinRoot, safeJoin, walkSafeFiles } from "../../../src/runtime/skills/path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 路径守卫测试（plans/phase-13.md §7.3 / §18.1）
// - `..` 逃逸 / 绝对路径 / UNC / 盘符 / NUL / 空名拒绝；
// - canonical + 目录包含判定；安全遍历拒绝 symlink/Junction。
// ═══════════════════════════════════════════════════════════════

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocf-path-test-"));
}

describe("assertSafeRelativeEntry（ZIP Slip / 相对路径条目）", () => {
  it("正常条目通过", () => {
    expect(() => assertSafeRelativeEntry("SKILL.md")).not.toThrow();
    expect(() => assertSafeRelativeEntry("references/guide.md")).not.toThrow();
  });

  it("拒绝父目录穿越", () => {
    expect(() => assertSafeRelativeEntry("../escape")).toThrow(SkillPathError);
    expect(() => assertSafeRelativeEntry("a/../../escape")).toThrow(SkillPathError);
  });

  it("拒绝绝对路径/盘符/UNC/非法字符", () => {
    expect(() => assertSafeRelativeEntry("/etc/passwd")).toThrow(SkillPathError);
    expect(() => assertSafeRelativeEntry("C:\\windows\\x")).toThrow(SkillPathError);
    expect(() => assertSafeRelativeEntry("\\\\server\\share\\x")).toThrow(SkillPathError);
    expect(() => assertSafeRelativeEntry("a\0b")).toThrow(SkillPathError);
    expect(() => assertSafeRelativeEntry("")).toThrow(SkillPathError);
  });

  it("ZIP 场景传入 skill_zip_slip 作为 reasonCode", () => {
    try {
      assertSafeRelativeEntry("../x", "skill_zip_slip");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SkillPathError);
      expect((error as SkillPathError).reasonCode).toBe("skill_zip_slip");
    }
  });
});

describe("canonical 路径与目录包含", () => {
  it("isPathWithinRoot：内部 true / 外部 false", () => {
    const root = tmpDir();
    const inner = path.join(root, "a", "b");
    fs.mkdirSync(inner, { recursive: true });
    expect(isPathWithinRoot(inner, root)).toBe(true);
    expect(isPathWithinRoot(root, root)).toBe(true);
    const outside = path.join(root, "..", "sibling");
    expect(isPathWithinRoot(outside, root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("safeJoin 拒绝逃逸", () => {
    const root = tmpDir();
    expect(safeJoin(root, "skill", "SKILL.md")).toBe(path.join(root, "skill", "SKILL.md"));
    expect(() => safeJoin(root, "..", "evil")).toThrow(SkillPathError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("canonicalPathSync 归一化盘符大小写差异", () => {
    const root = tmpDir();
    const canonical = canonicalPathSync(root);
    expect(path.isAbsolute(canonical)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("walkSafeFiles", () => {
  it("按相对路径排序返回文件清单", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "SKILL.md"), "x");
    fs.writeFileSync(path.join(root, "references", "guide.md"), "y");
    fs.writeFileSync(path.join(root, "a.txt"), "z");
    const entries = walkSafeFiles(root);
    expect(entries.map((entry) => entry.rel)).toEqual(["SKILL.md", "a.txt", "references/guide.md"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("拒绝符号链接/Junction（Windows 上创建失败则跳过）", () => {
    const root = tmpDir();
    const target = tmpDir();
    fs.writeFileSync(path.join(target, "secret.txt"), "secret");
    const link = path.join(root, "link");
    let created = true;
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      created = false;
    }
    try {
      if (created) {
        expect(() => walkSafeFiles(root)).toThrow(SkillPathError);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("缺目录时抛错（fail-closed）", () => {
    expect(() => walkSafeFiles(path.join(os.tmpdir(), "does-not-exist-ocf"))).toThrow();
  });
});
