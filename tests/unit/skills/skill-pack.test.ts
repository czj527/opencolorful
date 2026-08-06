import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillError } from "../../../src/runtime/skills/errors.js";
import { computeSkillContentHash } from "../../../src/runtime/skills/hash.js";
import { packSkillPackage, assertPackOutputExists } from "../../../src/runtime/skills/pack.js";
import { DEFAULT_SKILL_PACKAGE_LIMITS, validateSkillPackage } from "../../../src/runtime/skills/validator.js";
import { assertSkillZipTarget, buildSkillZip, crc32, writeSkillZipFile } from "../../../src/runtime/skills/zip-builder.js";
import {
  extractSkillZip,
  locateEndOfCentralDirectory,
  parseCentralDirectory,
} from "../../../src/runtime/skills/sources/zip-extract.js";
import { createSkillPackage, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 `skills pack` / zip-builder（plans/phase-13.md §14.3 / §15.1）
//
// - 确定性 ZIP：同一输入 → 相同 Buffer（store 方法 + 固定排序）；
// - 内容哈希与 validate 同源；.git 排除；
// - 只打包安全遍历（符号链接/Junction/非常规文件拒绝）；
// - 输出路径白名单（.zip/.skill）。
// ═══════════════════════════════════════════════════════════════

let workdir: string;

afterEach(() => {
  if (workdir !== undefined) {
    rmrf(workdir);
    workdir = "";
  }
});

describe("crc32（store 方法必需；校验值 0xCBF43926）", () => {
  it("CRC-32/ISO-HDLC 标准校验值", () => {
    expect(crc32(Buffer.from("123456789", "ascii")) >>> 0).toBe(0xcbf43926);
  });

  it("空内容 CRC 为 0", () => {
    expect(crc32(Buffer.alloc(0)) >>> 0).toBe(0);
  });
});

describe("buildSkillZip（确定性 + 可解析）", () => {
  it("同一输入两次构建产生相同 Buffer", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "zip-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "notes.md"), "按需读取的资料\n");
    const first = buildSkillZip(dir);
    const second = buildSkillZip(dir);
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.fileCount).toBe(2);
  });

  it("产物可被 zip-extract 解析且内容一致", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "zip-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "notes.md"), "按需读取的资料\n");
    const { buffer, fileCount } = buildSkillZip(dir);
    const eocdOffset = locateEndOfCentralDirectory(buffer);
    expect(eocdOffset).toBeGreaterThan(0);
    const entries = parseCentralDirectory(buffer, eocdOffset);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["SKILL.md", "references/notes.md"]);
    const destRoot = path.join(workdir, "unpacked");
    const extracted = extractSkillZip(buffer, entries, destRoot, DEFAULT_SKILL_PACKAGE_LIMITS);
    expect(extracted.fileCount).toBe(2);
    expect(fs.readFileSync(path.join(destRoot, "references", "notes.md"), "utf8")).toContain("按需读取");
    expect(fileCount).toBe(2);
  });

  it(".git 目录被排除", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "zip-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), "git", "utf8");
    const { fileCount } = buildSkillZip(dir, { exclude: [".git"] });
    expect(fileCount).toBe(1);
  });
});

describe("packSkillPackage（validate → .skill → 内容哈希）", () => {
  it("打包成功：输出存在、哈希与 validate 一致、SKILL.md 解析正确", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "pack-demo", version: "1.2.3" });
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "templates", "out.md"), "# 模板\n");
    const target = path.join(workdir, "dist", "pack-demo-1.2.3.skill");
    const result = packSkillPackage(dir, target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBeGreaterThan(0);
    expect(result.skillId).toBe("pack-demo");
    expect(result.version).toBe("1.2.3");
    expect(result.fileCount).toBe(2);
    const validation = validateSkillPackage({ packageRoot: dir, version: "1.2.3" });
    expect(validation.ok).toBe(true);
    expect(result.contentHash).toBe(validation.contentHash);
    expect(result.contentHash).toBe(computeSkillContentHash(dir, { version: "1.2.3", exclude: [".git"] }));
    assertPackOutputExists(target);
  });

  it("缺省输出文件名 <cwd>/<skillId>-<version>.skill", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "pack-default", version: "0.1.0" });
    const previousCwd = process.cwd();
    try {
      process.chdir(workdir);
      const result = packSkillPackage(dir);
      expect(path.basename(result.zipPath)).toBe("pack-default-0.1.0.skill");
      expect(fs.existsSync(result.zipPath)).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("缺少 SKILL.md → skill_not_a_complete_package（fail-closed）", () => {
    workdir = tmpDir("ocf-pack-");
    const bare = path.join(workdir, "bare");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "notes.txt"), "no manifest", "utf8");
    expect(() => packSkillPackage(bare)).toThrow(SkillError);
    try {
      packSkillPackage(bare);
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_not_a_complete_package");
    }
  });

  it("输出路径非 .zip/.skill → skill_package_invalid", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "pack-ext", version: "1.0.0" });
    expect(() => assertSkillZipTarget(path.join(workdir, "out.tar.gz"))).toThrow(SkillError);
    expect(() => packSkillPackage(dir, path.join(workdir, "out.tar.gz"))).toThrow(SkillError);
  });

  it("writeSkillZipFile 支持缺省排除与递归建目录", () => {
    workdir = tmpDir("ocf-pack-");
    const dir = createSkillPackage(workdir, { name: "write-zip", version: "1.0.0" });
    const target = path.join(workdir, "a", "b", "out.skill");
    const built = writeSkillZipFile(dir, target);
    expect(built.fileCount).toBe(1);
    expect(fs.existsSync(target)).toBe(true);
  });
});
