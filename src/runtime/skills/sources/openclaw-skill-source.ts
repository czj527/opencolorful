import fs from "node:fs";
import path from "node:path";

import type { SkillSourceCandidate, SkillSourceKind, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import type { SkillSourceAdapter, SkillSourceDiscoveryScope, SkillSourceInspection, SkillStageOptions } from "./skill-source-adapter.js";
import { SkillSourceCapabilities } from "../../../contracts/skill-protocol.js";
import { scanEcoMirror, stageEcoEntry, inspectEcoEntry, resolveEcoVersion, requireMirrorDir, type EcosystemMirrorOptions } from "./ecosystem-mirror.js";
import type { SkillResolvedVersion } from "./skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 OpenClaw / ClawHub Skill 适配器（plans/phase-13.md §8.3 / §15.2）
//
// ClawHub 是 OpenClaw 的公开 Skill 注册表（clawhub.ai）：文本型 Agent Skill
// （SKILL.md + 支持文件），带版本、slug 与锁定语义。本适配器：
//
// - 离线优先：registryDir = 本地固定版本镜像（ClawHub 下载固化目录或
//   自建 fixture），默认 CI 绝不请求真实 ClawHub；sourceRef 规范形式
//   openclaw:<skillId>@<version>（不支持 latest，锁定版本是安全基线）；
// - 转换：metadata.openclaw.requires{os,bins,env,tools,capabilities,
//   network} 由 T2 标准化层转换到 opencolorful.requires；network:true 只
//   记录降级提示（"仅作风险展示，不授予网络权限"），绝不授权网络访问；
// - 兼容失败给出迁移建议（compat/ecosystem-migration.ts），不生成表面成功
//   但运行时空壳的 Skill；不安装外部项目 CLI/Hook/运行时脚本作为隐式依赖
//   （只复制与校验，绝不执行任何来源脚本/postinstall）；
// - 远程市场（无镜像目录）时 discover 返回空、inspect/stage 给出明确诊断，
//   不把"无镜像"伪装成"没有 Skill"。
// ═══════════════════════════════════════════════════════════════

export interface OpenClawSkillSourceOptions {
  /** 本地 ClawHub 镜像目录（固定版本夹具/下载固化）；缺省 = 无市场可用（明确诊断） */
  readonly registryDir?: string;
}

const OPENCLAW_ORIGIN = "https://clawhub.ai/skills/";

export class OpenClawSkillSource implements SkillSourceAdapter {
  readonly kind = "openclaw" as const;

  constructor(private readonly options: OpenClawSkillSourceOptions = {}) {}

  private mirrorOptions(): EcosystemMirrorOptions {
    return {
      ...(this.options.registryDir !== undefined ? { mirrorDir: this.options.registryDir } : {}),
      prefix: "openclaw",
      sourceKind: "external",
      originalUrlFor: (skillId, version) => `${OPENCLAW_ORIGIN}${skillId}@${version}`,
    };
  }

  /** 搜索本地镜像候选（ClawHub 搜索的离线等价物；不安装、不请求网络）。 */
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

  /** inspect = ClawHub skill_view 语义：provenance + 完整 Manifest + 兼容报告 + 风险摘要。 */
  inspect(sourceRef: string): SkillSourceInspection {
    requireMirrorDir(this.options.registryDir, "openclaw");
    return inspectEcoEntry(this.options.registryDir as string, sourceRef, this.mirrorOptions());
  }

  /** stage：镜像条目 → 受控 staging（只复制；兼容失败给迁移建议）。 */
  stage(sourceRef: string, options?: SkillStageOptions): SkillStagedPackage {
    const stagingRoot = options?.stagingRoot ?? this.tempStagingDir();
    return stageEcoEntry(this.options.registryDir as string, sourceRef, stagingRoot, this.mirrorOptions());
  }

  /** 锁定版本与内容哈希（镜像条目内容确定性）。 */
  resolveVersion(sourceRef: string): SkillResolvedVersion {
    requireMirrorDir(this.options.registryDir, "openclaw");
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
    return fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "ocf-openclaw-"));
  }
}
