import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SkillSourceError } from "../../../src/runtime/skills/errors.js";
import { OpenClawSkillSource } from "../../../src/runtime/skills/sources/openclaw-skill-source.js";
import { HermesSkillSource } from "../../../src/runtime/skills/sources/hermes-skill-source.js";
import {
  parseEcoSkillRef,
  resolveEcoEntry,
  scanEcoMirror,
  stageEcoEntry,
} from "../../../src/runtime/skills/sources/ecosystem-mirror.js";
import { migrationAdviceFor, assertEcoInstallable } from "../../../src/runtime/skills/compat/ecosystem-migration.js";
import {
  emitYamlFrontmatter,
  normalizeBlockSequenceMaps,
  rewriteHermesSkillFrontmatter,
  rewriteHermesSkillPackage,
} from "../../../src/runtime/skills/compat/hermes-skill-rewrite.js";
import { parseSkillDocument, parseYamlFrontmatter } from "../../../src/runtime/skills/frontmatter.js";
import { validateSkillPackage } from "../../../src/runtime/skills/validator.js";
import { rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 生态适配器与迁移建议测试（plans/phase-13.md §8.3 / §8.4 / §15.2 / §18.7）
//
// - 全部使用 tests/fixtures/skills/ 固定本地 fixture（进入默认 CI，不请求外网）；
// - OpenClaw：requires 字段映射、os 名称映射、network 仅降级提示（不授权网络）、
//   兼容失败给迁移建议、scripts 风险标记、二进制拒绝；
// - Hermes：platforms/commands/required_environment*/user-invocable 转换、
//   原包不被修改、转换后哈希一致；
// - 发射器与 T2 解析器 round-trip 等价（parse(emit(parse(x))) 保持值语义）。
// ═══════════════════════════════════════════════════════════════

const FIXTURES = path.resolve("tests/fixtures/skills");
const OPENCLAW_REGISTRY = path.join(FIXTURES, "registry-openclaw");
const HERMES_REGISTRY = path.join(FIXTURES, "registry-hermes");

function expectSourceError(fn: () => unknown, code: string): SkillSourceError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SkillSourceError);
  expect((caught as SkillSourceError).code).toBe(code);
  return caught as SkillSourceError;
}

/** 临时镜像：把单包 fixture 复制为 mirrorDir/<name>@<version>/。 */
function makeTempMirror(packageDir: string, name: string, version: string): string {
  const mirror = tmpDir("ocf-eco-mirror-");
  const entry = path.join(mirror, `${name}@${version}`);
  fs.mkdirSync(entry, { recursive: true });
  fs.cpSync(packageDir, entry, { recursive: true });
  return mirror;
}

describe("ecosystem-mirror 共享层", () => {
  it("parseEcoSkillRef：锁定版本规范形式，拒绝 latest/格式非法", () => {
    expect(parseEcoSkillRef("openclaw:hello-openclaw@1.0.0", "openclaw")).toEqual({ skillId: "hello-openclaw", version: "1.0.0" });
    expectSourceError(() => parseEcoSkillRef("hermes:x@latest", "hermes"), "skill_source_not_found");
    expectSourceError(() => parseEcoSkillRef("http:foo@1.0.0", "openclaw"), "skill_source_not_found");
    expectSourceError(() => parseEcoSkillRef("openclaw:no-version", "openclaw"), "skill_source_not_found");
  });

  it("resolveEcoEntry：精确匹配，未知版本给明确诊断", () => {
    const entry = resolveEcoEntry(OPENCLAW_REGISTRY, "openclaw:hello-openclaw@1.0.0", "openclaw");
    expect(entry.skillId).toBe("hello-openclaw");
    expect(fs.existsSync(path.join(entry.entryDir, "SKILL.md"))).toBe(true);
    expectSourceError(() => resolveEcoEntry(OPENCLAW_REGISTRY, "openclaw:hello-openclaw@9.9.9", "openclaw"), "skill_source_not_found");
  });

  it("scanEcoMirror：无镜像目录 → 空（fail-closed，不伪装成没有 Skill）", () => {
    expect(scanEcoMirror(undefined, { prefix: "openclaw", sourceKind: "external", originalUrlFor: () => "https://clawhub.ai/s/" })).toHaveLength(0);
    expectSourceError(() => scanEcoMirror("/nonexistent/mirror", { prefix: "openclaw", sourceKind: "external", originalUrlFor: () => "u" }), "skill_source_not_found");
  });
});

describe("OpenClawSkillSource（registry-openclaw 镜像）", () => {
  const source = new OpenClawSkillSource({ registryDir: OPENCLAW_REGISTRY });

  it("discover：全部镜像候选 + 元数据与 provenance", () => {
    const candidates = source.discover();
    expect(candidates).toHaveLength(4);
    const hello = candidates.find((c) => c.sourceId === "openclaw:hello-openclaw@1.0.0");
    expect(hello).toBeDefined();
    expect(hello?.sourceKind).toBe("external");
    expect(hello?.displayName).toBe("Hello OpenClaw");
    expect(hello?.version).toBe("1.0.0");
    expect(hello?.provenance?.originalUrl).toBe("https://clawhub.ai/skills/hello-openclaw@1.0.0");
    expect(hello?.provenance?.license).toBe("MIT");
  });

  it("discover：query 过滤", () => {
    expect(source.discover("network")).toHaveLength(1);
    expect(source.discover("不存在")).toHaveLength(0);
  });

  it("inspect：兼容等级 openclaw + requires 字段映射 + os 名称映射", () => {
    const inspection = source.inspect("openclaw:hello-openclaw@1.0.0");
    expect(inspection.errors).toHaveLength(0);
    expect(inspection.manifest?.compatibilityLevel).toBe("openclaw");
    expect(inspection.compatibility?.level).toBe("openclaw");
    expect(inspection.manifest?.opencolorful?.requires).toEqual({
      os: ["win32", "linux", "darwin"],
      bins: ["git", "curl"],
      env: ["OPENCLAW_HOME"],
      tools: ["bash"],
      capabilities: ["filesystem-read"],
    });
    expect(inspection.manifest?.disableModelInvocation).toBe(true);
    // 原始 openclaw 字段被消费进转换结果；顶层 version 等保留在 rawFrontmatter
    expect(inspection.manifest?.rawFrontmatter["version"]).toBe("1.0.0");
  });

  it("inspect：network:true 只产生降级提示，不产生任何网络授权", () => {
    for (const ref of ["openclaw:hello-openclaw@1.0.0", "openclaw:network-heavy@0.9.0"]) {
      const inspection = source.inspect(ref);
      expect(inspection.compatibility?.degradation).toContain("网络");
      expect(inspection.compatibility?.degradation).toContain("不授予网络权限");
      // opencolorful.requires 无 network 字段（Schema 无此键）；未产生任何授权
      const requires = inspection.manifest?.opencolorful?.requires;
      expect(requires !== undefined && "network" in requires).toBe(false);
    }
    const networkHeavy = source.inspect("openclaw:network-heavy@0.9.0");
    expect(networkHeavy.manifest?.opencolorful?.requires?.env).toEqual(["NETWORK_API_TOKEN"]);
    expect(networkHeavy.manifest?.opencolorful?.requires?.tools).toEqual(["web-fetch"]);
  });

  it("resolveVersion：锁定版本 + 确定性内容哈希", () => {
    const resolved = source.resolveVersion("openclaw:hello-openclaw@1.0.0");
    expect(resolved.version).toBe("1.0.0");
    expect(resolved.contentHash).toMatch(/^sha256-[0-9a-f]{57}$/);
  });

  it("stage：受控 staging + provenance（sourceRef/originalUrl/license）+ 哈希一致", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const staged = source.stage("openclaw:hello-openclaw@1.0.0", { stagingRoot });
      expect(staged.packageRoot.startsWith(path.resolve(stagingRoot))).toBe(true);
      expect(staged.provenance.sourceRef).toBe("openclaw:hello-openclaw@1.0.0");
      expect(staged.provenance.originalUrl).toBe("https://clawhub.ai/skills/hello-openclaw@1.0.0");
      expect(staged.provenance.license).toBe("MIT");
      expect(staged.contentHash).toBe(source.resolveVersion("openclaw:hello-openclaw@1.0.0").contentHash);
      // staging 副本完整可校验
      const validation = validateSkillPackage({ packageRoot: staged.packageRoot, version: "1.0.0" });
      expect(validation.ok).toBe(true);
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("stage：兼容失败（unsupported / metadata-only）→ skill_package_invalid + 迁移建议", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const unsupported = expectSourceError(
        () => source.stage("openclaw:broken-unsupported@0.1.0", { stagingRoot }),
        "skill_package_invalid",
      );
      expect(unsupported.message).toContain("迁移建议");
      expect(unsupported.message).toContain("version");
      const hollow = expectSourceError(
        () => source.stage("openclaw:hollow-metadata-only@0.1.0", { stagingRoot }),
        "skill_package_invalid",
      );
      expect(hollow.message).toContain("迁移建议");
      expect(hollow.message).toContain("正文为空");
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("无镜像目录：明确诊断，不把失败伪装成没有 Skill", () => {
    const bare = new OpenClawSkillSource();
    expect(bare.discover()).toHaveLength(0);
    expect(bare.capabilities().search).toBe(false);
    expect(bare.capabilities().offline).toBe(false);
    const error = expectSourceError(() => bare.inspect("openclaw:hello-openclaw@1.0.0"), "skill_source_not_found");
    expect(error.message).toContain("镜像目录");
  });

  it("capabilities：配置镜像后支持搜索与离线", () => {
    expect(source.capabilities()).toEqual({ search: true, install: true, update: false, offline: true });
  });

  it("scripts 风险：inspect 标记 code=scripts（不阻断安装）", () => {
    const mirror = makeTempMirror(path.join(FIXTURES, "risky-scripts"), "risky-scripts", "1.0.0");
    try {
      const risky = new OpenClawSkillSource({ registryDir: mirror });
      const inspection = risky.inspect("openclaw:risky-scripts@1.0.0");
      expect(inspection.risks?.some((risk) => risk.code === "scripts")).toBe(true);
      expect(inspection.errors).toHaveLength(0);
      // scripts 可安装（只标记风险），但绝不执行
      const stagingRoot = tmpDir("ocf-eco-stage-");
      try {
        const staged = risky.stage("openclaw:risky-scripts@1.0.0", { stagingRoot });
        expect(fs.existsSync(path.join(staged.packageRoot, "scripts", "run.sh"))).toBe(true);
      } finally {
        rmrf(stagingRoot);
      }
    } finally {
      rmrf(mirror);
    }
  });

  it("二进制拒绝：stage → skill_binary_denied + 迁移建议（建议转 Plugin）", () => {
    const mirror = makeTempMirror(path.join(FIXTURES, "binary-pkg"), "binary-pkg", "1.0.0");
    try {
      const binary = new OpenClawSkillSource({ registryDir: mirror });
      const inspection = binary.inspect("openclaw:binary-pkg@1.0.0");
      expect(inspection.errors.some((error) => error.reasonCode === "skill_binary_denied")).toBe(true);
      const stagingRoot = tmpDir("ocf-eco-stage-");
      try {
        const error = expectSourceError(() => binary.stage("openclaw:binary-pkg@1.0.0", { stagingRoot }), "skill_binary_denied");
        expect(error.message).toContain("迁移建议");
      } finally {
        rmrf(stagingRoot);
      }
    } finally {
      rmrf(mirror);
    }
  });
});

describe("HermesSkillSource（registry-hermes 镜像 + T9 转换）", () => {
  const source = new HermesSkillSource({ registryDir: HERMES_REGISTRY });

  it("discover ↔ skills_list：候选元数据（不加载正文）", () => {
    const candidates = source.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceId).toBe("hermes:hermes-notes@1.3.0");
    expect(candidates[0]?.version).toBe("1.3.0");
    expect(source.discover("notes")).toHaveLength(1);
  });

  it("inspect ↔ skill_view：兼容等级 hermes + 兼容报告", () => {
    const inspection = source.inspect("hermes:hermes-notes@1.3.0");
    expect(inspection.errors).toHaveLength(0);
    expect(inspection.manifest?.compatibilityLevel).toBe("hermes");
    expect(inspection.compatibility?.level).toBe("hermes");
    // T2 基础转换在 inspect（原包形态）即生效：metadata.hermes + prerequisites.commands 的 bins 尚缺
    // （commands/required_environment* 的补全发生在 stage 的副本上）
    expect(inspection.manifest?.rawFrontmatter["platforms"]).toEqual(["linux", "windows", "macos"]);
  });

  it("stage：T9 转换（platforms/commands/required_environment*/user-invocable）→ 校验通过且 requires 正确", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const staged = source.stage("hermes:hermes-notes@1.3.0", { stagingRoot });
      const validation = validateSkillPackage({ packageRoot: staged.packageRoot, version: "1.3.0" });
      expect(validation.ok).toBe(true);
      const manifest = validation.manifest!;
      expect(manifest.compatibilityLevel).toBe("hermes");
      expect(manifest.opencolorful?.requires).toEqual({
        os: ["linux", "win32", "darwin"],
        bins: ["jq", "git", "python3"],
        env: ["HERMES_HOME"],
      });
      // user-invocable: false → 仅显式触发
      expect(manifest.disableModelInvocation).toBe(true);
      // 原始字段保留在 rawFrontmatter（转换诊断可查，不丢失）
      const raw = manifest.rawFrontmatter;
      expect(raw["platforms"]).toEqual(["linux", "windows", "macos"]);
      expect((raw["prerequisites"] as Record<string, unknown>)["commands"]).toEqual(["jq", "git"]);
      expect(raw["required_environment"]).toBe("python3");
      expect(raw["required_environment_variables"]).toHaveLength(1);
      expect((raw["required_environment_variables"] as Array<Record<string, unknown>>)[0]?.["name"]).toBe("HERMES_HOME");
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("stage：镜像原包不被修改（原 SKILL.md 字节保持原样，哈希可复核）", () => {
    const original = fs.readFileSync(path.join(HERMES_REGISTRY, "hermes-notes@1.3.0", "SKILL.md"), "utf8");
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      source.stage("hermes:hermes-notes@1.3.0", { stagingRoot });
      const after = fs.readFileSync(path.join(HERMES_REGISTRY, "hermes-notes@1.3.0", "SKILL.md"), "utf8");
      expect(after).toBe(original);
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("resolveVersion 与 stage 内容哈希一致（均按转换后内容计算）", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const staged = source.stage("hermes:hermes-notes@1.3.0", { stagingRoot });
      const resolved = source.resolveVersion("hermes:hermes-notes@1.3.0");
      expect(resolved.version).toBe("1.3.0");
      expect(resolved.contentHash).toBe(staged.contentHash);
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("stage：metadata-only Hermes 包 → 迁移建议拒绝", () => {
    const mirror = makeTempMirror(path.join(FIXTURES, "registry-openclaw", "hollow-metadata-only@0.1.0"), "hollow", "0.1.0");
    try {
      const hollow = new HermesSkillSource({ registryDir: mirror });
      const stagingRoot = tmpDir("ocf-eco-stage-");
      try {
        const error = expectSourceError(() => hollow.stage("hermes:hollow@0.1.0", { stagingRoot }), "skill_package_invalid");
        expect(error.message).toContain("迁移建议");
      } finally {
        rmrf(stagingRoot);
      }
    } finally {
      rmrf(mirror);
    }
  });

  it("stage：Hermes 生态包不安装外部 CLI/Hook/脚本作为隐式依赖（只复制）", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const staged = source.stage("hermes:hermes-notes@1.3.0", { stagingRoot });
      const files = walkFiles(staged.packageRoot);
      // 包内只有 SKILL.md（+ 支持文件），无任何可执行/依赖安装痕迹
      expect(files.some((file) => file.includes("node_modules") || file.includes("package.json"))).toBe(false);
    } finally {
      rmrf(stagingRoot);
    }
  });

  it("capabilities：镜像配置后 search/offline 开启", () => {
    expect(source.capabilities()).toEqual({ search: true, install: true, update: false, offline: true });
  });
});

describe("hermes-skill-rewrite（frontmatter 转换模块）", () => {
  it("round-trip：发射器输出与 T2 解析器互为等价（含数值字符串/布尔/嵌套映射/空值/多行）", () => {
    const record: Record<string, unknown> = {
      name: "sample",
      version: "1.2.3",
      floaty: "0.5",
      count: 42,
      flag: true,
      nothing: null,
      tags: ["a", "b"],
      meta: { nested: { deep: "x" }, list: [1, 2] },
      emptyArr: [],
      emptyMap: {},
      tricky: "has: colon and # hash and, comma",
      multiline: "line1\nline2\nline3",
      url: "https://example.com/a:b?q=1",
    };
    const emitted = emitYamlFrontmatter(record);
    const reparsed = parseYamlFrontmatter(emitted);
    expect(reparsed).toEqual(record);
    // 二次发射幂等
    expect(emitYamlFrontmatter(reparsed)).toBe(emitted);
  });

  it("normalizeBlockSequenceMaps：块序列映射项 → 流映射项（值语义保持）", () => {
    const input = "required_environment_variables:\n  - name: TOKEN\n    prompt: A token, keep it secret\n    required_for: all requests\nplatforms: [linux]";
    const normalized = normalizeBlockSequenceMaps(input);
    expect(normalized).toContain("- {name: \"TOKEN\", prompt: \"A token, keep it secret\", required_for: \"all requests\"}");
    expect(normalized).toContain("platforms: [linux]");
    const record = parseYamlFrontmatter(normalized as string);
    expect(record["platforms"]).toEqual(["linux"]);
    const vars = record["required_environment_variables"] as Array<Record<string, unknown>>;
    expect(vars[0]?.["name"]).toBe("TOKEN");
    expect(vars[0]?.["prompt"]).toBe("A token, keep it secret");
  });

  it("normalizeBlockSequenceMaps：嵌套块等不支持形态 → null（fail-closed，不产出损坏文本）", () => {
    const input = "items:\n  - name: x\n    nested:\n      - 1\n      - 2";
    expect(normalizeBlockSequenceMaps(input)).toBeNull();
  });

  it("无 Hermes 专属字段 → changed=false 且原文逐字节不变", () => {
    const source = "---\nname: plain\ndescription: d\nversion: 1.0.0\n---\n正文\n";
    const result = rewriteHermesSkillFrontmatter(source);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it("real 形态（registry-hermes fixture）转换清单正确", () => {
    const fixture = path.join(HERMES_REGISTRY, "hermes-notes@1.3.0", "SKILL.md");
    const result = rewriteHermesSkillFrontmatter(fs.readFileSync(fixture, "utf8"));
    expect(result.changed).toBe(true);
    expect(result.conversions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("platforms → platform"),
        expect.stringContaining("prerequisites.commands → prerequisites.bins"),
        expect.stringContaining("required_environment → prerequisites.bins"),
        expect.stringContaining("required_environment_variables → prerequisites.env"),
        expect.stringContaining("user-invocable: false"),
      ]),
    );
    // 重写结果可被 T2 解析器完整解析
    const parsed = parseSkillDocument(result.source);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.frontmatter["platform"]).toEqual(["linux", "windows", "macos"]);
    }
  });

  it("rewriteHermesSkillPackage：只改 staging 副本", () => {
    const packageDir = tmpDir("ocf-eco-pkg-");
    try {
      fs.cpSync(path.join(HERMES_REGISTRY, "hermes-notes@1.3.0"), packageDir, { recursive: true });
      const before = fs.readFileSync(path.join(packageDir, "SKILL.md"), "utf8");
      const result = rewriteHermesSkillPackage(packageDir);
      expect(result.changed).toBe(true);
      const after = fs.readFileSync(path.join(packageDir, "SKILL.md"), "utf8");
      expect(after).not.toBe(before);
      // 无转换字段的包不改写（字节不变 → 内容哈希不变）
      const plain = tmpDir("ocf-eco-pkg-");
      try {
        fs.cpSync(path.join(FIXTURES, "pi-standard"), plain, { recursive: true });
        const plainBefore = fs.readFileSync(path.join(plain, "SKILL.md"), "utf8");
        expect(rewriteHermesSkillPackage(plain).changed).toBe(false);
        expect(fs.readFileSync(path.join(plain, "SKILL.md"), "utf8")).toBe(plainBefore);
      } finally {
        rmrf(plain);
      }
    } finally {
      rmrf(packageDir);
    }
  });
});

describe("migrationAdviceFor / assertEcoInstallable", () => {
  it("metadata-only / unsupported 等级给出中文迁移建议", () => {
    const metaOnly = migrationAdviceFor("hermes", { level: "metadata-only", missing: [], requiresManualMigration: true });
    expect(metaOnly).toContain("正文为空");
    expect(metaOnly).toContain("迁移建议");
    const unsupported = migrationAdviceFor("openclaw", { level: "unsupported", missing: ["metadata.opencolorful.version=1"], requiresManualMigration: true });
    expect(unsupported).toContain("metadata.opencolorful");
    expect(unsupported).toContain("网络");
  });

  it("requiresManualMigration=false 时不拒绝（可安装）", () => {
    const advice = assertEcoInstallable("openclaw", { level: "openclaw", missing: [], requiresManualMigration: false });
    expect(advice.length).toBeGreaterThan(0);
  });

  it("requiresManualMigration=true 时抛 skill_package_invalid（含迁移建议）", () => {
    let caught: unknown;
    try {
      assertEcoInstallable("hermes", { level: "unsupported", missing: ["x"], requiresManualMigration: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SkillSourceError);
    expect((caught as SkillSourceError).code).toBe("skill_package_invalid");
    expect((caught as SkillSourceError).message).toContain("迁移建议");
  });

  it("描述性生态元数据（metadata.openclaw.* / metadata.hermes.*）不阻断安装，硬性字段阻断", () => {
    // 真实生态包普遍携带的描述性子键（tags/emoji/primaryEnv...）→ 可安装
    const benign = assertEcoInstallable("hermes", {
      level: "hermes",
      missing: ["metadata.hermes.tags", "metadata.hermes.category", "metadata.hermes.related_skills"],
      requiresManualMigration: true,
    });
    expect(benign.length).toBeGreaterThan(0);
    // 硬性未转换字段（os 无法映射 / 未知高风险）→ 拒绝
    let caught: unknown;
    try {
      assertEcoInstallable("openclaw", {
        level: "openclaw",
        missing: ["os:freebsd", "unknown-high-risk:permissions"],
        requiresManualMigration: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SkillSourceError);
    expect((caught as SkillSourceError).message).toContain("os:freebsd");
  });

  it("无报告（无法解析）→ 格式层面建议", () => {
    const advice = migrationAdviceFor("openclaw", null);
    expect(advice).toContain("SKILL.md");
  });
});

describe("stageEcoEntry 直连（共享层）", () => {
  it("复制 → 校验 → 哈希，绝不执行来源脚本", () => {
    const stagingRoot = tmpDir("ocf-eco-stage-");
    try {
      const staged = stageEcoEntry(OPENCLAW_REGISTRY, "openclaw:hello-openclaw@1.0.0", stagingRoot, {
        prefix: "openclaw",
        sourceKind: "external",
        originalUrlFor: (id, version) => `https://clawhub.ai/skills/${id}@${version}`,
      });
      expect(staged.contentHash).toMatch(/^sha256-[0-9a-f]{57}$/);
      expect(staged.fileCount).toBeGreaterThanOrEqual(1);
      expect(staged.provenance.originalUrl).toBe("https://clawhub.ai/skills/hello-openclaw@1.0.0");
    } finally {
      rmrf(stagingRoot);
    }
  });
});

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(path.relative(root, abs).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return files;
}
