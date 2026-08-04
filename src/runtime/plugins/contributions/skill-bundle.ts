import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Skill Bundle Contribution（plans/phase-12.md §8.10 / §三）
//
// - Phase 12 只识别并登记插件携带的 skills/ 目录（SkillBundleContribution）；
// - 不执行技能发现、渐进披露、注入、市场搜索或自动启用；
// - UI 明确显示"等待技能系统支持"（statusText()）；
// - 技能系统的 precedence / snapshot / prompt budget 由技能系统阶段定义，
//   本阶段不建立任何技能语义。
// ═══════════════════════════════════════════════════════════════

export interface SkillBundleDescriptor {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  /** 插件声明的 skills/ 目录相对路径（只登记，不读取/解析内容） */
  readonly skillsDir?: string;
}

export interface SkillBundleServiceDeps {
  readonly registry: ContributionRegistry;
}

export class SkillBundleService {
  constructor(private readonly deps: SkillBundleServiceDeps) {}

  /** 只登记：列出插件携带的 skill bundle 声明（不发现/不注入/不执行）。 */
  list(pluginId: string): SkillBundleDescriptor[] {
    return this.deps.registry
      .listByKind(pluginId, "skill-bundle")
      .map((contribution) => this.toDescriptor(contribution))
      .filter((descriptor): descriptor is SkillBundleDescriptor => descriptor !== undefined);
  }

  listAll(): SkillBundleDescriptor[] {
    const result: SkillBundleDescriptor[] = [];
    for (const pluginId of this.deps.registry.listPlugins()) {
      result.push(...this.list(pluginId));
    }
    return result;
  }

  /** Phase 12 永不激活技能。 */
  isActivated(): false {
    return false;
  }

  /** UI 展示文案。 */
  statusText(): string {
    return "等待技能系统支持";
  }

  private toDescriptor(contribution: RegisteredContribution): SkillBundleDescriptor | undefined {
    if (contribution.kind !== "skill-bundle") {
      return undefined;
    }
    const descriptor: SkillBundleDescriptor = {
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
    };
    const skillsDir = contribution.spec["skillsDir"];
    return typeof skillsDir === "string" && skillsDir.length > 0 ? { ...descriptor, skillsDir } : descriptor;
  }
}
