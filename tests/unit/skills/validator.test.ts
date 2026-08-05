import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SKILL_BUDGETS } from "../../../src/contracts/skill-protocol.js";
import { DEFAULT_SKILL_PACKAGE_LIMITS, peekSkillManifest, validateSkillPackage } from "../../../src/runtime/skills/validator.js";
import { createSkillPackage, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 包结构与完整性校验测试（plans/phase-13.md §7.3 / §18.1）
// ═══════════════════════════════════════════════════════════════

describe("validateSkillPackage：完整包", () => {
  it("完整包通过（manifest/hash/size/fileCount 齐备）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "git-workflow", version: "1.2.0" });
    const result = validateSkillPackage({ packageRoot, version: "1.2.0" });
    expect(result.ok).toBe(true);
    expect(result.manifest?.name).toBe("git-workflow");
    expect(result.contentHash).toMatch(/^sha256-[0-9a-f]{57}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.fileCount).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("缺少 SKILL.md → skill_not_a_complete_package（不接受裸内容）", () => {
    const root = tmpDir();
    const dir = path.join(root, "not-a-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.txt"), "不是完整包");
    const result = validateSkillPackage({ packageRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_not_a_complete_package")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("无 frontmatter → skill_manifest_invalid", () => {
    const root = tmpDir();
    const dir = path.join(root, "skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# 只有正文\n");
    const result = validateSkillPackage({ packageRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_manifest_invalid")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("包根目录不存在 → skill_package_invalid", () => {
    const result = validateSkillPackage({ packageRoot: path.join(os.tmpdir(), "missing-ocf-skill") });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.reasonCode).toBe("skill_package_invalid");
  });
});

describe("validateSkillPackage：大小与文件类型限制", () => {
  it("单文件超过上限（沿用 SKILL_BUDGETS.maxSingleFileBytes）→ skill_too_large", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "big" });
    fs.writeFileSync(path.join(packageRoot, "big.bin.txt"), "a".repeat(DEFAULT_SKILL_PACKAGE_LIMITS.maxFileBytes + 1));
    const result = validateSkillPackage({ packageRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_too_large")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("整包超过总大小上限 → skill_too_large", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "bulk" });
    fs.writeFileSync(path.join(packageRoot, "chunk.txt"), "x".repeat(DEFAULT_SKILL_PACKAGE_LIMITS.maxPackageBytes + 1));
    const result = validateSkillPackage({ packageRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_too_large")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("非法文件类型 → skill_file_type_denied", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "weird" });
    fs.writeFileSync(path.join(packageRoot, "data.xyz"), "x");
    const result = validateSkillPackage({ packageRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_file_type_denied" && error.path === "data.xyz")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("禁止的二进制扩展名 → skill_binary_denied", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "bin" });
    fs.writeFileSync(path.join(packageRoot, "evil.exe"), "MZ");
    const result = validateSkillPackage({ packageRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.reasonCode === "skill_binary_denied")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("validateSkillPackage：符号链接逃逸", () => {
  it("包内 symlink/Junction 逃逸 → skill_symlink_escape（创建失败则跳过）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "linky" });
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    let created = true;
    try {
      fs.symlinkSync(outside, path.join(packageRoot, "escape"), "junction");
    } catch {
      created = false;
    }
    try {
      if (created) {
        const result = validateSkillPackage({ packageRoot });
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.reasonCode === "skill_symlink_escape")).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("peekSkillManifest", () => {
  it("轻量读取 name/version/description", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "peeky", version: "3.1.0" });
    const peek = peekSkillManifest(packageRoot);
    expect(peek.ok).toBe(true);
    expect(peek.name).toBe("peeky");
    expect(peek.version).toBe("3.1.0");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("无版本字段 → version null（fail-closed 不伪造版本）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "peeky" });
    const peek = peekSkillManifest(packageRoot);
    expect(peek.ok).toBe(true);
    expect(peek.version).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
