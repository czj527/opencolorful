import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeJoin } from "../paths.js";
import {
  SourceFetchError,
  SourceIntegrityError,
  SourceResolveError,
  assertPluginSourceRef,
  computeArtifactHash,
  manifestVersion,
  readManifestFile,
  type ArtifactVerification,
  type FetchedArtifact,
  type PluginSourceAdapter,
  type PluginSourceRef,
  type ResolvedSource,
  type SourceSearchResult,
  type SourceVersionInfo,
} from "./source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Git Source Adapter：本地 Git 仓库，固定 commit/tag。
//
// - ref = 本地仓库目录（含 .git）；version/lock 必须提供 commit/tag，
//   禁止自动拉取 latest；
// - fetch：git clone --no-checkout（本地仓库，离线）→ 检出到固定 commit，
//   内容根目录随 staging 提供；
// - verifyArtifact 排除 .git 目录（.git 是 VCS 元数据，不是插件内容）。
// ═══════════════════════════════════════════════════════════════

const GIT_TIMEOUT_MS = 30_000;

export class GitSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "git" as const;

  private requireRepo(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("git_repo_missing", "Git 仓库目录不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("git_repo_symlink", "Git 仓库目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SourceResolveError("git_repo_not_dir", "Git 来源不是目录");
    }
    if (!fs.existsSync(path.join(resolved, ".git"))) {
      throw new SourceResolveError("git_repo_no_git", "Git 来源缺少 .git 目录");
    }
    return resolved;
  }

  private runGit(repo: string, args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new SourceFetchError("git_command_failed", "Git 操作失败");
    }
  }

  private resolveCommit(repo: string, sourceRef: PluginSourceRef): string {
    const pin = sourceRef.version ?? sourceRef.lock;
    if (pin === undefined || pin.length === 0) {
      throw new SourceResolveError("git_pin_required", "Git 来源必须固定 commit/tag，禁止自动拉取 latest");
    }
    try {
      return this.runGit(repo, ["rev-parse", "--verify", `${pin}^{commit}`]);
    } catch {
      throw new SourceResolveError("git_pin_invalid", "Git commit/tag 不存在");
    }
  }

  search(): readonly SourceSearchResult[] {
    return [];
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const repo = this.requireRepo(ref.ref);
    const commit = this.resolveCommit(repo, ref);
    return { sourceType: "git", ref: repo, version: ref.version ?? null, lock: commit, metadata: { commit } };
  }

  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[] {
    const ref = assertPluginSourceRef(sourceRef);
    const repo = this.requireRepo(ref.ref);
    const tags = this.runGit(repo, ["tag", "--list"])
      .split(/\r?\n/)
      .filter((tag) => tag.length > 0);
    return tags.map((tag) => ({ version: tag, lock: null }));
  }

  fetchArtifact(sourceRef: PluginSourceRef, options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const repo = this.requireRepo(ref.ref);
    const commit = this.resolveCommit(repo, ref);
    const stagingDir = options?.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "plugin-git-"));
    const checkoutDir = safeJoin(stagingDir, "checkout");
    try {
      this.runGit(repo, ["clone", "--no-checkout", "--quiet", repo, checkoutDir]);
      this.runGit(repo, ["-C", checkoutDir, "checkout", "--detach", "--quiet", commit]);
    } catch (error) {
      try {
        fs.rmSync(checkoutDir, { recursive: true, force: true });
      } catch {
        /* 尽力清理 */
      }
      if (error instanceof SourceFetchError) {
        throw error;
      }
      throw new SourceFetchError("git_checkout_failed", "Git 检出失败");
    }
    const raw = readManifestFile(checkoutDir);
    const version = manifestVersion(raw);
    if (version === null) {
      throw new SourceIntegrityError("manifest_version_missing", "插件 manifest 缺少 version");
    }
    if (ref.version !== undefined && ref.version !== version) {
      throw new SourceResolveError("version_mismatch", "请求版本与插件实际版本不一致");
    }
    return {
      sourceType: "git",
      ref: repo,
      version,
      lock: commit,
      contentRoot: checkoutDir,
      metadata: { manifest: raw, commit },
    };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot, { exclude: [".git"] });
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    let summary = artifact.lock ?? "";
    try {
      summary = this.runGit(artifact.ref, ["log", "-1", "--format=%H|%an|%s"]);
    } catch {
      /* 仓库不可读时仅保留 commit */
    }
    return {
      sourceType: "git",
      commit: artifact.lock ?? "",
      summary,
      manifest: readManifestFile(artifact.contentRoot),
    };
  }
}
