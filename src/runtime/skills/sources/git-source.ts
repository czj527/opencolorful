import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { peekSkillManifest } from "../validator.js";
import {
  inspectLocalDirectory,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
  type SkillStageOptions,
} from "./skill-source-adapter.js";
import { buildStagedPackage, copyPackageTree, locateSkillPackageRoot } from "./stage-utils.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 Git Skill Source（plans/phase-13.md §8.3 / §12.3）
//
// - sourceRef = git 仓库 URL 或本地路径；stage：git clone --depth 1
//   （--no-checkout 后显式 checkout，**不执行来源仓库的任何 hook/脚本**）
//   → 定位技能子目录 → 受控复制到 staging（排除 .git）；
// - 版本取 frontmatter（与校验/哈希一致）；commit 固化进 provenance.sourceRef；
// - exec 可注入（默认 execFileSync("git")），单元测试不请求真实网络；
// - 失败只抛稳定 reasonCode 的 SkillSourceError，不把网络失败伪装成"没有 Skill"。
// ═══════════════════════════════════════════════════════════════

export interface GitCommandRunner {
  (args: readonly string[], options: { readonly cwd?: string }): string;
}

const GIT_TIMEOUT_MS = 30_000;

function defaultGitRunner(): GitCommandRunner {
  return (args, options) =>
    execFileSync("git", [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

interface PreparedRepo {
  readonly cloneDir: string;
  readonly packageRoot: string;
  readonly commit: string;
}

export class GitSkillSource implements SkillSourceAdapter {
  readonly kind = "git" as const;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly deps: { readonly exec?: GitCommandRunner } = {},
  ) {}

  discover(_query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    return [];
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const prepared = this.prepareRepo(sourceRef, this.cacheDirFor(sourceRef));
    return inspectLocalDirectory(prepared.packageRoot);
  }

  stage(sourceRef: string, options?: SkillStageOptions): SkillStagedPackage {
    const stagingRoot = options?.stagingRoot ?? this.tempStagingDir();
    try {
      const prepared = this.prepareRepo(sourceRef, safeStagingJoin(stagingRoot, "clone"));
      const stagedRoot = safeStagingJoin(stagingRoot, "package");
      copyPackageTree(prepared.packageRoot, stagedRoot, { exclude: [".git"] });
      // 版本取 frontmatter（与 resolveVersion/校验一致）；commit 固化进 provenance
      return buildStagedPackage(stagedRoot, {
        sourceRef: `${sourceRef}#${prepared.commit}`,
        originalUrl: sourceRef,
      });
    } catch (error) {
      if (error instanceof SkillSourceError) {
        throw error;
      }
      throw new SkillSourceError("skill_source_not_found", error instanceof Error ? error.message : "Git 暂存失败");
    }
  }

  resolveVersion(sourceRef: string): SkillResolvedVersion {
    const prepared = this.prepareRepo(sourceRef, this.cacheDirFor(sourceRef));
    const staged = buildStagedPackage(prepared.packageRoot, { sourceRef: `${sourceRef}#${prepared.commit}`, originalUrl: sourceRef });
    const peek = peekSkillManifest(prepared.packageRoot);
    return { version: peek.version ?? "0.0.0", contentHash: staged.contentHash };
  }

  capabilities(): { search: false; install: true; update: true; offline: false } {
    return { search: false, install: true, update: true, offline: false };
  }

  private runGit(args: readonly string[], options: { readonly cwd?: string } = {}): string {
    const runner = this.deps.exec ?? defaultGitRunner();
    try {
      return runner(args, options);
    } catch (error) {
      throw new SkillSourceError("skill_source_not_found", error instanceof Error ? error.message : "Git 命令执行失败");
    }
  }

  private prepareRepo(sourceRef: string, cloneDir: string): PreparedRepo {
    fs.mkdirSync(cloneDir, { recursive: true });
    this.runGit(["clone", "--depth", "1", "--no-checkout", "--quiet", sourceRef, cloneDir]);
    // 显式 checkout 到默认分支 HEAD（克隆阶段无 checkout；fresh clone 无 hook 目录）
    this.runGit(["-C", cloneDir, "checkout", "--detach", "--quiet", "HEAD"], { cwd: cloneDir });
    const commit = this.runGit(["-C", cloneDir, "rev-parse", "--short", "HEAD"], { cwd: cloneDir });
    const packageRoot = locateSkillPackageRoot(cloneDir);
    return { cloneDir, packageRoot, commit };
  }

  /** git commit 短哈希作为版本参与内容哈希（同 commit 幂等，内容变化哈希变化）。 */
  private cacheDirFor(sourceRef: string): string {
    const cacheDir = safeStagingJoin(this.paths.skillsCache, "git");
    fs.mkdirSync(cacheDir, { recursive: true });
    return safeStagingJoin(cacheDir, `repo-${crypto.createHash("sha1").update(sourceRef).digest("hex").slice(0, 16)}`);
  }

  private tempStagingDir(): string {
    fs.mkdirSync(this.paths.skillsStaging, { recursive: true });
    return fs.mkdtempSync(path.join(this.paths.skillsStaging, "git-"));
  }
}

function safeStagingJoin(root: string, ...segments: string[]): string {
  const joined = path.join(root, ...segments);
  const relative = path.relative(path.resolve(root), path.resolve(joined));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SkillSourceError("skill_path_escape", "暂存路径逃逸，已拒绝");
  }
  return joined;
}
