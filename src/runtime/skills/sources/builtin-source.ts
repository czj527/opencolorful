import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { peekSkillManifest } from "../validator.js";
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
// Builtin Skill Source（plans/phase-13.md §8.1）
// - 扫描 ${OPENCOLORFUL_HOME}/skills/builtin/（平台随版本提供，trusted）；
// - 每个含 SKILL.md 的子目录是一个 Skill 包；版本缺省 1.0.0；
// - sourceId/sourceRef = 包根目录绝对路径；stage 由 T3 安装器实现。
// ═══════════════════════════════════════════════════════════════

export class BuiltinSkillSource implements SkillSourceAdapter {
  readonly kind = "local" as const;

  constructor(private readonly paths: RuntimePaths) {}

  discover(query?: string, scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    void scope;
    return scanPackagesInDirectoryWithQuery(this.paths.skillsBuiltin, query, {
      sourceKind: "builtin",
      sourceId: (rootPath) => rootPath,
      defaultVersion: "1.0.0",
      buildProvenance: (rootPath) => ({ sourceRef: rootPath, fetchedAt: nowIsoTimestamp() }),
    }).map((found) => found.candidate);
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const packageRoot = path.resolve(sourceRef);
    const version = this.resolveLocalVersion(packageRoot);
    return inspectLocalDirectory(packageRoot, { version });
  }

  stage(_sourceRef: string): SkillStagedPackage {
    throw new SkillSourceError("skill_source_unsupported", "staging 由 T3 安装器实现（builtin 来源）");
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
    return peek.version ?? "1.0.0";
  }
}
