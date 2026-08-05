import path from "node:path";

import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { peekSkillManifest } from "../validator.js";
import type { SkillTrustPolicy } from "./trust-config.js";
import {
  inspectLocalDirectory,
  nowIsoTimestamp,
  scanPackagesInDirectoryWithQuery,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
} from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// External Local Directory Source（plans/phase-13.md §8.1 / §11.3）
// - 用户显式提供的本地目录（scope.baseDir）下的一层子目录候选；
// - sourceKind=external；默认扫描启用但不可信（trust policy 决策）；
// - git/http/archive/openclaw/hermes 适配器骨架由 T3/T9 实现。
// ═══════════════════════════════════════════════════════════════

export class ExternalLocalSkillSource implements SkillSourceAdapter {
  readonly kind = "local" as const;

  constructor(private readonly trust: SkillTrustPolicy) {}

  discover(query?: string, scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    const baseDir = scope?.baseDir;
    if (baseDir === undefined || baseDir.trim() === "") {
      return [];
    }
    return scanPackagesInDirectoryWithQuery(baseDir, query, {
      sourceKind: "external",
      sourceId: (rootPath) => rootPath,
      defaultVersion: "0.0.0",
      buildProvenance: (rootPath) => ({ sourceRef: rootPath, fetchedAt: nowIsoTimestamp() }),
    }).map((found) => found.candidate);
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const packageRoot = path.resolve(sourceRef);
    const version = this.resolveLocalVersion(packageRoot);
    return inspectLocalDirectory(packageRoot, { version });
  }

  stage(_sourceRef: string): SkillStagedPackage {
    throw new SkillSourceError("skill_source_unsupported", "staging 由 T3 安装器实现（external/local 来源）");
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
