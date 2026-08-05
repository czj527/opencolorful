import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeSkillContentHash, hashFileEntries } from "../../../src/runtime/skills/hash.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 确定性内容哈希测试（plans/phase-13.md §7.3 / §18.1）
// - 同一包两次哈希一致；内容变化哈希变化；frontmatter（SKILL.md）参与；
// - 版本参与；条目顺序无关；返回稳定 `sha256-<hex>`。
// ═══════════════════════════════════════════════════════════════

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocf-hash-test-"));
}

function writePackage(root: string, frontmatter: string, body = "正文\n"): void {
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\n${frontmatter}---\n${body}`, "utf8");
  fs.mkdirSync(path.join(root, "references"), { recursive: true });
  fs.writeFileSync(path.join(root, "references", "guide.md"), "参考\n", "utf8");
}

describe("computeSkillContentHash", () => {
  it("同一包两次哈希一致（确定性）", () => {
    const root = tmpDir();
    writePackage(root, "name: a\ndescription: d\n");
    const first = computeSkillContentHash(root);
    const second = computeSkillContentHash(root);
    expect(first).toBe(second);
    // 冻结契约 SkillRef.contentHash maxLength=64（sha256- 前缀 7 + 十六进制 57）
    expect(first).toMatch(/^sha256-[0-9a-f]{57}$/);
    expect(first.length).toBeLessThanOrEqual(64);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("内容变化 → 哈希变化", () => {
    const root = tmpDir();
    writePackage(root, "name: a\ndescription: d\n");
    const before = computeSkillContentHash(root);
    fs.writeFileSync(path.join(root, "references", "guide.md"), "改动\n", "utf8");
    const after = computeSkillContentHash(root);
    expect(after).not.toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("frontmatter 参与（name/description 变化 → 哈希变化）", () => {
    const root = tmpDir();
    writePackage(root, "name: a\ndescription: d\n");
    const before = computeSkillContentHash(root);
    writePackage(root, "name: b\ndescription: d\n");
    const after = computeSkillContentHash(root);
    expect(after).not.toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("版本参与哈希", () => {
    const root = tmpDir();
    writePackage(root, "name: a\ndescription: d\n");
    expect(computeSkillContentHash(root, { version: "1.0.0" })).not.toBe(computeSkillContentHash(root, { version: "2.0.0" }));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("hashFileEntries", () => {
  it("条目顺序无关（按相对路径排序）", () => {
    const a = hashFileEntries([
      { rel: "b.txt", content: "bb" },
      { rel: "a.txt", content: "aa" },
    ]);
    const b = hashFileEntries([
      { rel: "a.txt", content: "aa" },
      { rel: "b.txt", content: "bb" },
    ]);
    expect(a).toBe(b);
  });

  it("版本参数前缀参与", () => {
    const noVersion = hashFileEntries([{ rel: "x", content: "x" }]);
    const withVersion = hashFileEntries([{ rel: "x", content: "x" }], "1.0.0");
    expect(noVersion).not.toBe(withVersion);
  });
});
