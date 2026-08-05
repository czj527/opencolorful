import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimePaths } from "../../../src/config/paths.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import type { SkillSourceCandidate, SkillSourceKind } from "../../../src/contracts/skill-protocol.js";
import type { ReadinessEnvironment } from "../../../src/runtime/skills/readiness.js";
import type { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import type { SkillSourceInspection } from "../../../src/runtime/skills/sources/skill-source-adapter.js";
import { validateSkillPackage } from "../../../src/runtime/skills/validator.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 测试共享辅助（tests/unit/skills/）
// ═══════════════════════════════════════════════════════════════

export function tmpDir(prefix = "ocf-skills-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface CreateSkillPackageOptions {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  /** 额外 top-level frontmatter 行（原样写入） */
  readonly extraFrontmatter?: string;
  readonly body?: string;
  readonly license?: string;
}

/** 创建完整 Skill 包（SKILL.md + frontmatter + 正文）。 */
export function createSkillPackage(root: string, options: CreateSkillPackageOptions = {}): string {
  const dir = path.join(root, options.name ?? "test-skill");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${options.name ?? "test-skill"}`,
    `description: ${options.description ?? "测试用 Skill"}`,
    ...(options.version !== undefined ? [`version: ${options.version}`] : []),
    ...(options.license !== undefined ? [`license: ${options.license}`] : []),
    ...(options.extraFrontmatter !== undefined ? options.extraFrontmatter.split("\n") : []),
    "---",
    options.body ?? "这是 Skill 正文。",
  ];
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

export function makeSkillPackageAt(rootDir: string, subdir: string, options: CreateSkillPackageOptions = {}): string {
  const dir = path.join(rootDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${options.name ?? "test-skill"}`,
    `description: ${options.description ?? "测试用 Skill"}`,
    ...(options.version !== undefined ? [`version: ${options.version}`] : []),
    ...(options.license !== undefined ? [`license: ${options.license}`] : []),
    ...(options.extraFrontmatter !== undefined ? options.extraFrontmatter.split("\n") : []),
    "---",
    options.body ?? "这是 Skill 正文。",
  ];
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

/** 临时 RuntimePaths（OPENCOLORFUL_HOME 指向临时目录）。 */
export function tempPaths(prefix = "ocf-home-"): { readonly paths: RuntimePaths; readonly home: string } {
  const home = tmpDir(prefix);
  return { paths: getRuntimePaths({ OPENCOLORFUL_HOME: home }), home };
}

/** 默认环境快照。 */
export function makeEnv(overrides: Partial<ReadinessEnvironment> = {}): ReadinessEnvironment {
  return {
    os: "win32",
    bins: ["git"],
    env: ["PATH", "HOME"],
    plugins: [],
    tools: [],
    capabilities: [],
    skills: [],
    ...overrides,
  };
}

/** 生成冻结形状的候选。 */
export function makeCandidate(rootPath: string, sourceKind: SkillSourceKind, displayName: string, version = "1.0.0"): SkillSourceCandidate {
  return {
    sourceId: path.resolve(rootPath),
    sourceKind,
    displayName,
    version,
    provenance: { sourceRef: path.resolve(rootPath), fetchedAt: new Date().toISOString() },
  };
}

/** 对包执行完整校验得到 inspection（哈希等）。 */
export function makeInspection(packageRoot: string, version?: string): SkillSourceInspection {
  const validation = validateSkillPackage({ packageRoot, ...(version !== undefined ? { version } : {}) });
  return {
    sourceRef: path.resolve(packageRoot),
    packageRoot: path.resolve(packageRoot),
    manifest: validation.manifest,
    compatibility: validation.compatibility,
    contentHash: validation.contentHash ?? "",
    sizeBytes: validation.sizeBytes,
    fileCount: validation.fileCount,
    errors: validation.errors,
  };
}

/** 便捷登记：建包 + 校验 + 注入 Catalog。 */
export function ingestPackage(catalog: SkillCatalog, packageRoot: string, sourceKind: SkillSourceKind, env: ReadinessEnvironment, options: { readonly version?: string; readonly trusted?: boolean } = {}): ReturnType<SkillCatalog["ingestCandidate"]> {
  const inspection = makeInspection(packageRoot, options.version);
  const candidate = makeCandidate(packageRoot, sourceKind, inspection.manifest?.name ?? "test-skill", inspection.manifest?.rawFrontmatter["version"] as string | undefined ?? options.version ?? "1.0.0");
  return catalog.ingestCandidate({ candidate, inspection, trusted: options.trusted ?? true, environment: env });
}

/** 递归删除目录（清理用）。 */
export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}
