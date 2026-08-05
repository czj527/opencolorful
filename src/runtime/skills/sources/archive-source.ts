import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import type { SkillPackageLimits } from "../validator.js";
import { DEFAULT_SKILL_PACKAGE_LIMITS, peekSkillManifest } from "../validator.js";
import {
  inspectLocalDirectory,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
  type SkillStageOptions,
} from "./skill-source-adapter.js";
import { buildStagedPackage, copyPackageTree, locateSkillPackageRoot, toSkillSourceError } from "./stage-utils.js";
import { extractSkillZip, locateEndOfCentralDirectory, parseCentralDirectory } from "./zip-extract.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 Archive Skill Source（plans/phase-13.md §8.3 / §12.2）
//
// - sourceRef = 本地 .zip/.skill 归档路径（只接受完整 package）；
// - stage：读归档 → ZIP Slip/重复路径/大小/文件类型校验 → 解包到受控 staging；
// - inspect/resolveVersion：解包到 cache 后做轻量读取（inspect 不落 installed）；
// - 失败只抛稳定 reasonCode 的 SkillSourceError，不把网络/解析失败伪装成"没有 Skill"。
// ═══════════════════════════════════════════════════════════════

export class ArchiveSkillSource implements SkillSourceAdapter {
  readonly kind = "archive" as const;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly options: { readonly limits?: Partial<SkillPackageLimits> } = {},
  ) {}

  discover(_query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    return [];
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const unpackRoot = this.cacheUnpackRoot(sourceRef);
    return inspectLocalDirectory(unpackRoot);
  }

  stage(sourceRef: string, options?: SkillStageOptions): SkillStagedPackage {
    const zipPath = this.requireArchiveFile(sourceRef);
    const stagingRoot = options?.stagingRoot ?? this.tempStagingDir();
    try {
      const unpackRoot = safeStagingJoin(stagingRoot, "unpacked");
      this.extractArchiveTo(zipPath, unpackRoot);
      const packageRoot = locateSkillPackageRoot(unpackRoot);
      const stagedRoot = safeStagingJoin(stagingRoot, "package");
      copyPackageTree(packageRoot, stagedRoot, { exclude: [".git"] });
      return buildStagedPackage(stagedRoot, { sourceRef: zipPath, originalUrl: zipPath });
    } catch (error) {
      throw toSkillSourceError(error);
    }
  }

  resolveVersion(sourceRef: string): SkillResolvedVersion {
    const zipPath = this.requireArchiveFile(sourceRef);
    const unpackRoot = this.cacheUnpackRoot(zipPath);
    const packageRoot = locateSkillPackageRoot(unpackRoot);
    const staged = buildStagedPackage(packageRoot, { sourceRef: zipPath });
    const peek = peekSkillManifest(packageRoot);
    return { version: peek.version ?? "0.0.0", contentHash: staged.contentHash };
  }

  capabilities(): { search: false; install: true; update: false; offline: true } {
    return { search: false, install: true, update: false, offline: true };
  }

  private requireArchiveFile(sourceRef: string): string {
    const resolved = path.resolve(sourceRef);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SkillSourceError("skill_source_not_found", `归档文件不存在：${resolved}`);
    }
    if (stat.isSymbolicLink()) {
      throw new SkillSourceError("skill_source_unsupported", "归档文件不允许是符号链接或 Junction");
    }
    if (!stat.isFile()) {
      throw new SkillSourceError("skill_source_not_found", `来源不是归档文件：${resolved}`);
    }
    if (!resolved.toLowerCase().endsWith(".zip") && !resolved.toLowerCase().endsWith(".skill")) {
      throw new SkillSourceError("skill_not_a_complete_package", "归档来源只接受 .zip / .skill 文件");
    }
    return resolved;
  }

  private extractArchiveTo(zipPath: string, destRoot: string): void {
    const buffer = fs.readFileSync(zipPath);
    const eocdOffset = locateEndOfCentralDirectory(buffer);
    const entries = parseCentralDirectory(buffer, eocdOffset);
    if (entries.length === 0) {
      throw new SkillSourceError("skill_not_a_complete_package", "归档为空，不是完整 Skill 包");
    }
    const limits: SkillPackageLimits = { ...DEFAULT_SKILL_PACKAGE_LIMITS, ...(this.options.limits ?? {}) };
    try {
      extractSkillZip(buffer, entries, destRoot, limits);
    } catch (error) {
      throw toSkillSourceError(error);
    }
  }

  private cacheUnpackRoot(sourceRef: string): string {
    const zipPath = this.requireArchiveFile(sourceRef);
    const cacheDir = safeStagingJoin(this.paths.skillsCache, "archive");
    fs.mkdirSync(cacheDir, { recursive: true });
    const unpackRoot = safeStagingJoin(cacheDir, `${path.basename(zipPath)}.unpacked`);
    if (!fs.existsSync(path.join(unpackRoot, "SKILL.md"))) {
      fs.rmSync(unpackRoot, { recursive: true, force: true });
      fs.mkdirSync(unpackRoot, { recursive: true });
      this.extractArchiveTo(zipPath, unpackRoot);
    }
    return unpackRoot;
  }

  private tempStagingDir(): string {
    fs.mkdirSync(this.paths.skillsStaging, { recursive: true });
    return fs.mkdtempSync(path.join(this.paths.skillsStaging, "archive-"));
  }
}

/** 受控拼接（staging 内），与 path-safety.safeJoin 等价但带来源错误语义。 */
function safeStagingJoin(root: string, ...segments: string[]): string {
  const joined = path.join(root, ...segments);
  const relative = path.relative(path.resolve(root), path.resolve(joined));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SkillSourceError("skill_path_escape", "暂存路径逃逸，已拒绝");
  }
  return joined;
}
