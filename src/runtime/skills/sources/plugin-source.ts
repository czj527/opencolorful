import path from "node:path";

import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { peekSkillManifest } from "../validator.js";
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
// Plugin Skill Bundle Source（plans/phase-13.md §8.1 / §13.1）
//
// - Phase 12 插件携带 skills/ 目录的登记入口（T7 才接线到真实注册表）；
// - T2 提供 scan 接口签名与基础扫描：provider 注入后扫描其 skillsDir；
// - 不提供 provider 时 discover 返回空数组（fail-closed，不假装已发现）；
// - stage/resolveVersion 与其它本地适配器同构（staging 归 T3）。
// ═══════════════════════════════════════════════════════════════

/** Phase 12 SkillBundleDescriptor 的结构兼容形状（T7 接线时注入 Phase 12 注册表）。 */
export interface PluginSkillBundleInput {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  /** 插件声明的 skills/ 目录绝对路径（只扫描，不解析插件内部结构） */
  readonly skillsDir: string;
}

export interface PluginSkillBundleProvider {
  list(): readonly PluginSkillBundleInput[];
}

export class PluginSkillSource implements SkillSourceAdapter {
  readonly kind = "local" as const;

  constructor(private readonly deps: { readonly provider?: PluginSkillBundleProvider } = {}) {}

  discover(query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    const provider = this.deps.provider;
    if (provider === undefined) {
      return [];
    }
    const needle = (query ?? "").trim().toLowerCase();
    const results: SkillSourceCandidate[] = [];
    for (const bundle of provider.list()) {
      for (const found of scanPackagesInDirectory(bundle.skillsDir, {
        sourceKind: "plugin",
        sourceId: (rootPath) => rootPath,
        defaultVersion: bundle.version,
        buildProvenance: (rootPath) => ({
          sourceRef: `${bundle.pluginId}@${bundle.version}#${path.basename(rootPath)}`,
          fetchedAt: nowIsoTimestamp(),
        }),
      })) {
        if (needle !== "" && !found.candidate.displayName.toLowerCase().includes(needle) && !found.candidate.sourceId.toLowerCase().includes(needle)) {
          continue;
        }
        results.push(found.candidate);
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
    throw new SkillSourceError("skill_source_unsupported", "staging 由 T3 安装器实现（plugin 来源）");
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
