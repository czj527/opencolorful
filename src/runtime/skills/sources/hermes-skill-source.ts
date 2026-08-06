import fs from "node:fs";
import path from "node:path";

import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceCapabilities } from "../../../contracts/skill-protocol.js";
import { rewriteHermesSkillFrontmatter, rewriteHermesSkillPackage } from "../compat/hermes-skill-rewrite.js";
import { scanEcoMirror, stageEcoEntry, inspectEcoEntry, resolveEcoVersion, requireMirrorDir, type EcosystemMirrorOptions } from "./ecosystem-mirror.js";
import type { SkillResolvedVersion, SkillSourceAdapter, SkillSourceDiscoveryScope, SkillSourceInspection, SkillStageOptions } from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 Hermes Skill 适配器（plans/phase-13.md §8.3 / §15.2）
//
// Hermes Agent（NousResearch）以 skills/ 目录分发 SKILL.md 技能包，
// 平台通过 skills_list（列表元数据）/ skill_view（读取完整技能）渐进披露。
// 本适配器的语义映射：
//
//   discover ↔ skills_list：候选元数据（不加载正文）；
//   inspect  ↔ skill_view：provenance + 完整 Manifest + 兼容报告 + 风险摘要
//              （正文经 SkillContentService 按需读取，不一次性注入）；
//
// - 离线优先：registryDir = 本地固定版本镜像（Hermes 市场下载固化或自建
//   fixture），默认 CI 绝不请求外网；sourceRef = hermes:<skillId>@<version>；
// - T2 已转换 platform/prerequisites{os,bins,env}/requires；T9 在 staging
//   副本上补全真实 Hermes 字段（platforms 复数、prerequisites.commands、
//   required_environment、required_environment_variables、user-invocable），
//   原包在镜像中保持原样（内容哈希可复核）；
// - 兼容失败给出迁移建议，不生成表面成功但运行时空壳的 Skill；只复制与
//   校验，绝不执行任何来源脚本/postinstall（不安装隐式依赖）。
// ═══════════════════════════════════════════════════════════════

export interface HermesSkillSourceOptions {
  /** 本地 Hermes 市场镜像目录（固定版本夹具/下载固化）；缺省 = 无市场可用（明确诊断） */
  readonly registryDir?: string;
}

const HERMES_ORIGIN = "https://github.com/NousResearch/hermes-agent/tree/main/skills/";

export class HermesSkillSource implements SkillSourceAdapter {
  readonly kind = "hermes" as const;

  constructor(private readonly options: HermesSkillSourceOptions = {}) {}

  private mirrorOptions(): EcosystemMirrorOptions {
    return {
      ...(this.options.registryDir !== undefined ? { mirrorDir: this.options.registryDir } : {}),
      prefix: "hermes",
      sourceKind: "external",
      originalUrlFor: (skillId, version) => `${HERMES_ORIGIN}${skillId}@${version}`,
      rewriteStaged: (packageRoot) => rewriteHermesSkillPackage(packageRoot),
      convertForPeek: (source) => rewriteHermesSkillFrontmatter(source),
    };
  }

  /** discover ↔ skills_list：候选元数据（不加载正文）。 */
  discover(query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    const needle = (query ?? "").trim().toLowerCase();
    const all = scanEcoMirror(this.options.registryDir, this.mirrorOptions());
    if (needle === "") {
      return all;
    }
    return all.filter(
      (candidate) =>
        candidate.displayName.toLowerCase().includes(needle) || candidate.sourceId.toLowerCase().includes(needle),
    );
  }

  /** inspect ↔ skill_view：完整 Manifest + 兼容报告 + 风险摘要。 */
  inspect(sourceRef: string): SkillSourceInspection {
    requireMirrorDir(this.options.registryDir, "hermes");
    return inspectEcoEntry(this.options.registryDir as string, sourceRef, this.mirrorOptions());
  }

  /** stage：镜像条目 → 受控 staging；Hermes 专属字段在副本上转换后校验。 */
  stage(sourceRef: string, options?: SkillStageOptions): SkillStagedPackage {
    const stagingRoot = options?.stagingRoot ?? this.tempStagingDir();
    return stageEcoEntry(this.options.registryDir as string, sourceRef, stagingRoot, this.mirrorOptions());
  }

  /** 锁定版本与内容哈希（与 stage 同语义：Hermes 条目按转换后内容哈希）。 */
  resolveVersion(sourceRef: string): SkillResolvedVersion {
    requireMirrorDir(this.options.registryDir, "hermes");
    return resolveEcoVersion(this.options.registryDir as string, sourceRef, this.mirrorOptions());
  }

  capabilities(): SkillSourceCapabilities {
    return {
      search: this.options.registryDir !== undefined,
      install: true,
      update: false,
      offline: this.options.registryDir !== undefined,
    };
  }

  private tempStagingDir(): string {
    return fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "ocf-hermes-"));
  }
}
