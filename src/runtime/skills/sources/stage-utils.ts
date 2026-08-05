import fs from "node:fs";
import path from "node:path";

import type { SkillProvenance, SkillStagedPackage, SkillErrorCode } from "../../../contracts/skill-protocol.js";
import { SkillError, SkillSourceError } from "../errors.js";
import { safeJoin, SkillPathError, walkSafeFiles } from "../path-safety.js";
import { peekSkillManifest, validateSkillPackage } from "../validator.js";
import { nowIsoTimestamp } from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 来源暂存共享工具（plans/phase-13.md §7.3 / §8.3）
//
// - copyPackageTree：受控复制（复用 walkSafeFiles，拒绝 symlink/非常规文件）；
// - locateSkillPackageRoot：克隆/解包内容里定位含 SKILL.md 的完整包根；
// - buildStagedPackage：校验 + 版本 + 确定性哈希 → SkillStagedPackage；
// - stageLocalPackage：本地目录 → 复制到受控 staging。
// ═══════════════════════════════════════════════════════════════

/** 受控复制目录树（与 path-safety 同守卫；.git 等 VCS 元数据按需排除）。 */
export function copyPackageTree(
  source: string,
  destination: string,
  options: { readonly exclude?: readonly string[] } = {},
): void {
  const root = path.resolve(destination);
  const entries = walkSafeFiles(source, { ...(options.exclude !== undefined ? { exclude: options.exclude } : {}) });
  fs.mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const targetFile = safeJoin(root, entry.rel);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(entry.abs, targetFile);
  }
}

/**
 * 在克隆/解包根目录里定位完整 Skill 包根：根目录含 SKILL.md 直接使用，
 * 否则扫描一层子目录；找不到抛 skill_not_a_complete_package（不接受裸 Markdown）。
 */
export function locateSkillPackageRoot(fetchedRoot: string): string {
  const root = path.resolve(fetchedRoot);
  if (peekSkillManifest(root).ok) {
    return root;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    throw new SkillSourceError("skill_not_a_complete_package", "解包内容不可读，缺少完整 Skill 包");
  }
  for (const name of entries) {
    const candidate = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink() && peekSkillManifest(candidate).ok) {
      return candidate;
    }
  }
  throw new SkillSourceError("skill_not_a_complete_package", "解包内容中没有含 SKILL.md 的完整 Skill 包（不接受裸 skill_content/裸 Markdown）");
}

/** 读取包根 frontmatter 版本；缺省 0.0.0（无效包 fail-closed 抛错）。 */
export function resolveStagedVersion(packageRoot: string): string {
  const peek = peekSkillManifest(packageRoot);
  if (!peek.ok) {
    throw new SkillSourceError(peek.error?.reasonCode ?? "skill_not_a_complete_package", peek.error?.message ?? "暂存包缺少有效 SKILL.md");
  }
  return peek.version ?? "0.0.0";
}

export interface BuildStagedPackageInput {
  readonly sourceRef: string;
  /** 版本优先取入参（git 的 commit 版语义由调用方决定）；缺省取 frontmatter */
  readonly version?: string;
  readonly originalUrl?: string;
  readonly license?: string;
}

/**
 * 统一把任意错误转换为 SkillSourceError（保留稳定 reasonCode）：
 * - SkillError / SkillSourceError → 原 code；
 * - SkillPathError（zip slip / symlink / 路径逃逸）→ 原 reasonCode；
 * - 其余 → fallback（默认 skill_package_invalid）。
 */
export function toSkillSourceError(error: unknown, fallback: SkillErrorCode = "skill_package_invalid"): SkillSourceError {
  if (error instanceof SkillSourceError) {
    return error;
  }
  if (error instanceof SkillError) {
    return new SkillSourceError(error.code, error.message, error.detail);
  }
  if (error instanceof SkillPathError) {
    return new SkillSourceError(error.reasonCode, error.message);
  }
  return new SkillSourceError(fallback, error instanceof Error ? error.message : String(error));
}

/** 对已就位的完整包根做校验 + 确定性哈希，产出 SkillStagedPackage。 */
export function buildStagedPackage(packageRoot: string, input: BuildStagedPackageInput): SkillStagedPackage {
  const resolvedRoot = path.resolve(packageRoot);
  const version = input.version ?? resolveStagedVersion(resolvedRoot);
  const validation = validateSkillPackage({ packageRoot: resolvedRoot, version });
  if (!validation.ok || validation.contentHash === null) {
    const firstError = validation.errors[0];
    throw new SkillSourceError(
      firstError?.reasonCode ?? "skill_package_invalid",
      firstError?.message ?? "Skill 包校验失败",
    );
  }
  const provenance: SkillProvenance = {
    sourceRef: input.sourceRef,
    fetchedAt: nowIsoTimestamp(),
    ...(input.originalUrl !== undefined ? { originalUrl: input.originalUrl } : {}),
    ...(input.license !== undefined ? { license: input.license } : {}),
  };
  return {
    packageRoot: resolvedRoot,
    manifestPath: path.join(resolvedRoot, "SKILL.md"),
    contentHash: validation.contentHash,
    sizeBytes: validation.sizeBytes,
    fileCount: validation.fileCount,
    provenance,
  };
}

/**
 * 本地目录来源 staging：校验来源为常规目录（拒绝 symlink），受控复制到
 * staging 的 package 子目录，再产出 SkillStagedPackage。
 */
export function stageLocalPackage(sourceRef: string, stagingRoot: string): SkillStagedPackage {
  const resolved = path.resolve(sourceRef);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new SkillSourceError("skill_source_not_found", `来源目录不存在：${resolved}`);
  }
  if (stat.isSymbolicLink()) {
    throw new SkillSourceError("skill_source_unsupported", `来源目录不允许是符号链接或 Junction：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new SkillSourceError("skill_not_a_complete_package", `来源不是目录：${resolved}`);
  }
  if (!peekSkillManifest(resolved).ok) {
    throw new SkillSourceError("skill_not_a_complete_package", `来源目录缺少 SKILL.md（不接受裸 skill_content 冒充完整 Skill）：${resolved}`);
  }
  const packageRoot = safeJoin(path.resolve(stagingRoot), "package");
  copyPackageTree(resolved, packageRoot, { exclude: [".git"] });
  return buildStagedPackage(packageRoot, { sourceRef: resolved });
}
