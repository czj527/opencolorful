import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillError } from "../../../src/runtime/skills/errors.js";
import { LinkedSourceRegistry } from "../../../src/runtime/skills/sources/linked-source-registry.js";
import { validateSkillPackage } from "../../../src/runtime/skills/validator.js";
import { createSkillPackage, rmrf, tempPaths, type CreateSkillPackageOptions } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Linked Source 登记（plans/phase-13.md §9.2 / §14.3）
//
// - `skills link` 的领域层：登记文件在 skill-dev-sources/sources.json；
// - 只读引用（不复制到 Managed Store）；修改源码后下一次 list() 反映新哈希；
// - 登记/解析失败路径 fail-closed（损坏文件 → 空登记；绝不静默信任路径）。
// ═══════════════════════════════════════════════════════════════

let home: string;
let paths: ReturnType<typeof tempPaths>["paths"];
let registry: LinkedSourceRegistry;

afterEach(() => {
  if (home !== undefined) {
    rmrf(home);
    home = "";
  }
});

function setup(): void {
  const created = tempPaths("ocf-link-home-");
  home = created.home;
  paths = created.paths;
  registry = new LinkedSourceRegistry(paths);
}

function makeLinkedPackage(subdir: string, options: CreateSkillPackageOptions = {}): string {
  return createSkillPackage(path.join(home, "src"), { name: "linked-skill", ...options });
}

function registryFile(): string {
  return path.join(paths.skillDevSources, "sources.json");
}

describe("LinkedSourceRegistry.register", () => {
  it("登记有效目录：状态有效 + 哈希与 validate 一致 + 登记文件落盘", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-reg", version: "1.0.0" });
    const status = registry.register(dir);
    expect(status.sourceId).toBe("linked-linked-reg");
    expect(status.valid).toBe(true);
    expect(status.contentHash).toBe(
      validateSkillPackage({ packageRoot: dir, version: "1.0.0" }).contentHash,
    );
    expect(fs.existsSync(registryFile())).toBe(true);
    const document = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as {
      version: number;
      linkedSources: readonly { sourceId: string; rootPath: string }[];
    };
    expect(document.version).toBe(1);
    expect(document.linkedSources).toHaveLength(1);
  });

  it("只读引用：Managed Store 不出现拷贝", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-readonly", version: "1.0.0" });
    registry.register(dir);
    expect(fs.existsSync(path.join(paths.skillsInstalled))).toBe(false);
  });

  it("同一路径重复登记 → skill_already_installed", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-dup", version: "1.0.0" });
    registry.register(dir);
    try {
      registry.register(dir);
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_already_installed");
    }
  });

  it("同 sourceId 不同目录 → skill_version_conflict（同名需改名）", () => {
    setup();
    const first = createSkillPackage(path.join(home, "src", "a"), { name: "same-name", version: "1.0.0" });
    const second = createSkillPackage(path.join(home, "src", "b"), { name: "same-name", version: "1.0.0" });
    expect(path.resolve(first)).not.toBe(path.resolve(second));
    registry.register(first);
    try {
      registry.register(second);
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_version_conflict");
    }
  });

  it("缺 SKILL.md 的目录 → skill_not_a_complete_package", () => {
    setup();
    const bare = path.join(home, "src", "bare");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "readme.txt"), "没有 SKILL.md", "utf8");
    try {
      registry.register(bare);
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_not_a_complete_package");
    }
  });

  it("不存在的路径 → skill_source_not_found", () => {
    setup();
    try {
      registry.register(path.join(home, "missing"));
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_source_not_found");
    }
  });

  it("根目录为符号链接/Junction → skill_symlink_escape", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-symlink", version: "1.0.0" });
    const linkRoot = path.join(home, "src", "pkg-link");
    try {
      fs.symlinkSync(dir, linkRoot, "junction");
    } catch {
      // 平台不允许创建 junction 时跳过（如某些 CI 沙箱）
      return;
    }
    try {
      registry.register(linkRoot);
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_symlink_escape");
    }
  });
});

describe("LinkedSourceRegistry.list / get（实时重哈希）", () => {
  it("修改源码后下一次 list() 反映新内容哈希（下一 turn 生效语义）", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-hash", version: "1.0.0" });
    registry.register(dir);
    const before = registry.list();
    expect(before).toHaveLength(1);
    const firstHash = before[0]?.contentHash;
    expect(firstHash).toBeTruthy();
    // 修改正文 → 哈希变化
    fs.appendFileSync(path.join(dir, "SKILL.md"), "\n追加内容\n", "utf8");
    const after = registry.list();
    expect(after[0]?.contentHash).not.toBe(firstHash);
    // 再破坏 SKILL.md → valid=false + 错误信息（fail-closed）
    fs.writeFileSync(path.join(dir, "SKILL.md"), "不是 frontmatter", "utf8");
    const broken = registry.list();
    expect(broken[0]?.valid).toBe(false);
    expect(broken[0]?.errors.length).toBeGreaterThan(0);
  });

  it("get 按 sourceId 返回状态；未知 → null", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-get", version: "1.0.0" });
    registry.register(dir);
    expect(registry.get("linked-linked-get")).not.toBeNull();
    expect(registry.get("linked-missing")).toBeNull();
  });
});

describe("LinkedSourceRegistry.unregister（fail-closed）", () => {
  it("注销只删登记，不删源码目录", () => {
    setup();
    const dir = makeLinkedPackage("pkg", { name: "linked-unreg", version: "1.0.0" });
    registry.register(dir);
    const removed = registry.unregister("linked-linked-unreg");
    expect(removed.sourceId).toBe("linked-linked-unreg");
    expect(registry.list()).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("未知 sourceId → skill_source_not_found", () => {
    setup();
    try {
      registry.unregister("linked-ghost");
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as SkillError).code).toBe("skill_source_not_found");
    }
  });
});

describe("登记文件损坏（fail-closed）", () => {
  it("损坏 JSON → 空登记（不静默信任任何路径），register 仍可写入", () => {
    setup();
    fs.mkdirSync(paths.skillDevSources, { recursive: true });
    fs.writeFileSync(registryFile(), "{ 这不是 JSON", "utf8");
    expect(registry.list()).toHaveLength(0);
    const dir = makeLinkedPackage("pkg", { name: "linked-recover", version: "1.0.0" });
    const status = registry.register(dir);
    expect(status.valid).toBe(true);
    // 损坏文件已被原子覆盖为合法文档
    const document = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as {
      linkedSources: readonly unknown[];
    };
    expect(document.linkedSources).toHaveLength(1);
  });

  it("非法条目（缺 sourceId/rootPath）被跳过", () => {
    setup();
    fs.mkdirSync(paths.skillDevSources, { recursive: true });
    fs.writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        linkedSources: [
          { sourceId: "", rootPath: "C:\\x" },
          { sourceId: "ok", rootPath: "" },
          { sourceId: "linked-ok", rootPath: path.join(home, "src", "ok") },
        ],
      }),
      "utf8",
    );
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.sourceId).toBe("linked-ok");
  });

  it("版本不匹配（version != 1）→ 空登记", () => {
    setup();
    fs.mkdirSync(paths.skillDevSources, { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify({ version: 99, linkedSources: [] }), "utf8");
    expect(registry.list()).toHaveLength(0);
  });
});
