import path from "node:path";

import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { peekSkillManifest } from "../validator.js";
import type { SkillTrustPolicy } from "./trust-config.js";
import { workspaceCompatibilityRoots } from "./workspace-roots.js";
import {
  inspectLocalDirectory,
  nowIsoTimestamp,
  scanPackagesInDirectory,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
} from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Workspace / 兼容目录 Skill Source（plans/phase-13.md §8.1）
//
// - 扫描 <cwd>/<home> 下的 .agents/.claude/.codex/.openclaw/skills；
// - 默认关闭：只有用户显式信任根目录后才扫描（trust policy 判定）；
// - sourceId/sourceRef = 包根目录绝对路径；stage 由 T3 安装器实现。
// ═══════════════════════════════════════════════════════════════

export interface WorkspaceSkillSourceDeps {
  readonly cwd: string;
  readonly home: string;
  readonly trust: SkillTrustPolicy;
}

export class WorkspaceSkillSource implements SkillSourceAdapter {
  readonly kind = "local" as const;

  constructor(private readonly deps: WorkspaceSkillSourceDeps) {}

  discover(query?: string, scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    const baseDir = scope?.baseDir ?? this.deps.cwd;
    const results: SkillSourceCandidate[] = [];
    for (const root of workspaceCompatibilityRoots(baseDir, this.deps.home)) {
      if (!this.deps.trust.isRootTrusted(root)) {
        continue;
      }
      const found = scanPackagesInDirectory(root, {
        sourceKind: "workspace",
        sourceId: (rootPath) => rootPath,
        defaultVersion: "0.0.0",
        buildProvenance: (rootPath) => ({ sourceRef: rootPath, fetchedAt: nowIsoTimestamp() }),
      });
      const needle = (query ?? "").trim().toLowerCase();
      for (const item of found) {
        if (needle !== "" && !item.candidate.displayName.toLowerCase().includes(needle) && !item.candidate.sourceId.toLowerCase().includes(needle)) {
          continue;
        }
        results.push(item.candidate);
      }
    }
    return results;
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const packageRoot = path.resolve(sourceRef);
    const version = this.resolveLocalVersion(packageRoot);
    return inspectLocalDirectory(packageRoot, { version });
  }

  stage(_sourceRef: string): SkillStagedPackage {
    throw new SkillSourceError("skill_source_unsupported", "staging 由 T3 安装器实现（workspace 来源）");
  }

  resolveVersion(sourceRef: string): SkillResolvedVersion {
    const packageRoot = path.resolve(sourceRef);
    const version = this.resolveLocalVersion(packageRoot);
    return { version, contentHash: computeSkillContentHash(packageRoot, { version }) };
  }

  capabilities(): { search: true; install: false; update: false; offline: true } {
    return { search: true, install: false, update: false, offline: true };
  }

  private resolveLocalVersion(packageRoot: string): string {
    const peek = peekSkillManifest(packageRoot);
    if (!peek.ok) {
      throw new SkillSourceError(peek.error?.reasonCode ?? "skill_package_invalid", peek.error?.message ?? "Skill 包不可读");
    }
    return peek.version ?? "0.0.0";
  }
}
