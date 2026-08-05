import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { peekSkillManifest } from "../validator.js";
import {
  inspectLocalDirectory,
  nowIsoTimestamp,
  requireDirectory,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
} from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Managed Skill Source（plans/phase-13.md §8.1 / §9.2）
// - 扫描 ${OPENCOLORFUL_HOME}/skills/installed/<skillId>/<version>/；
// - 版本 = 版本目录名；包根 = <skillId>/<version> 目录；
// - sourceId/sourceRef = 包根目录绝对路径；stage 由 T3 安装器实现。
// ═══════════════════════════════════════════════════════════════

export class ManagedSkillSource implements SkillSourceAdapter {
  readonly kind = "local" as const;

  constructor(private readonly paths: RuntimePaths) {}

  discover(query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    const needle = (query ?? "").trim().toLowerCase();
    const storeRoot = this.paths.skillsInstalled;
    let skillDirs: string[];
    try {
      skillDirs = requireDirectory(storeRoot);
    } catch {
      return [];
    }
    const results: SkillSourceCandidate[] = [];
    for (const skillId of skillDirs) {
      const skillRoot = path.join(storeRoot, skillId);
      let versions: string[];
      try {
        versions = requireDirectory(skillRoot);
      } catch {
        continue;
      }
      for (const version of versions) {
        const packageRoot = path.join(skillRoot, version);
        const peek = peekSkillManifest(packageRoot);
        if (!peek.ok) {
          continue;
        }
        const displayName = peek.name ?? skillId;
        if (needle !== "" && !displayName.toLowerCase().includes(needle) && !skillId.toLowerCase().includes(needle)) {
          continue;
        }
        results.push({
          sourceId: packageRoot,
          sourceKind: "managed",
          displayName,
          version,
          ...(peek.description !== null ? { description: peek.description } : {}),
          provenance: { sourceRef: packageRoot, fetchedAt: nowIsoTimestamp() },
        });
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
    throw new SkillSourceError("skill_source_unsupported", "staging 由 T3 安装器实现（managed 来源）");
  }

  resolveVersion(sourceRef: string): SkillResolvedVersion {
    const packageRoot = path.resolve(sourceRef);
    const version = this.resolveLocalVersion(packageRoot);
    return { version, contentHash: computeSkillContentHash(packageRoot, { version }) };
  }

  capabilities(): { search: true; install: false; update: false; offline: true } {
    return { search: true, install: false, update: false, offline: true };
  }

  /** 版本目录名即版本（无 frontmatter version 依赖）。 */
  private resolveLocalVersion(packageRoot: string): string {
    const parent = path.basename(path.dirname(packageRoot));
    const version = path.basename(packageRoot);
    if (parent.length === 0 || version.length === 0) {
      throw new SkillSourceError("skill_package_invalid", `managed 版本目录结构非法：${packageRoot}`);
    }
    return version;
  }
}
