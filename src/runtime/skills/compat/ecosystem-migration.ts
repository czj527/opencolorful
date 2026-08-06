import type { SkillCompatibilityReport, SkillErrorCode } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import type { SkillPackageErrorInfo } from "../validator.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 生态兼容失败迁移建议（plans/phase-13.md §8.4 / §15.2 / §18.7）
//
// - 兼容失败必须给出迁移建议，绝不生成"表面成功但运行时空壳"的 Skill；
// - OpenClaw：metadata.openclaw.requires{os,bins,env,tools,capabilities,
//   network} 已由 T2 转换；network:true 只作降级提示（不授予网络权限）；
// - Hermes：platform/prerequisites 由 T2 转换，platforms/commands/
//   required_environment*/user-invocable 由 T9 适配器在 staging 重写
//   （hermes-skill-rewrite.ts），失败时在这里给出可执行的迁移提示；
// - 稳定 reasonCode 一律来自冻结的 SKILL_ERROR_CODES，不暴露内部细节。
// ═══════════════════════════════════════════════════════════════

export type EcosystemSkillKind = "openclaw" | "hermes";

export const ECOSYSTEM_KIND_LABEL: Record<EcosystemSkillKind, string> = {
  openclaw: "OpenClaw/ClawHub",
  hermes: "Hermes",
};

const LEVEL_ADVICE: Record<string, string> = {
  "metadata-only":
    "SKILL.md 正文为空，只有元数据，无法作为可执行 Skill 安装。迁移建议：为 SKILL.md 补充实际工作流程正文，或在元数据里声明 references/ 等支持文件后重试。",
  unsupported:
    "包内存在 OpenColorful 无法识别的扩展或结构（如 metadata.opencolorful.version 不是 1）。迁移建议：移除不支持的扩展字段，或改为标准 metadata.opencolorful（version: 1）后重新发布。",
};

/**
 * 生态描述性元数据的 missing 标记（T2 转换层对未知子键一律 dropped）：
 * 真实生态包普遍携带 metadata.openclaw.{emoji,primaryEnv,homepage,...} 与
 * metadata.hermes.{tags,related_skills,category,...}，这些只是描述性诊断，
 * 不是转换失败——不阻断安装（仍保留在兼容报告的 missing/degradation 里展示）。
 * 其余 missing（os:xxx 无法映射、unknown-high-risk:*、结构字段）仍是硬性阻断项。
 */
const BENIGN_ECO_MISSING: Record<EcosystemSkillKind, RegExp> = {
  openclaw: /^metadata\.openclaw\./,
  hermes: /^metadata\.hermes\./,
};

/**
 * 根据兼容报告生成中文迁移建议（缺报告时给出格式层面的建议）。
 * 只用于诊断展示与错误消息，不改变任何授权语义。
 */
export function migrationAdviceFor(kind: EcosystemSkillKind, report: SkillCompatibilityReport | null): string {
  if (report === null) {
    return `${ECOSYSTEM_KIND_LABEL[kind]} 包无法解析为完整 Skill。迁移建议：检查包内是否存在带 frontmatter 的 SKILL.md（name/description 必填），并按 OpenColorful Skill 1.0 格式整理后重试。`;
  }
  const lines: string[] = [];
  const levelAdvice = LEVEL_ADVICE[report.level];
  if (levelAdvice !== undefined) {
    lines.push(levelAdvice);
  }
  if (report.missing.length > 0) {
    lines.push(`缺失/不兼容字段：${report.missing.slice(0, 8).join("、")}${report.missing.length > 8 ? " 等" : ""}。`);
  }
  if (report.requiresManualMigration) {
    lines.push("需要人工迁移确认：请在转换后检查 requires/allowed-tools 等依赖提示是否符合预期，再重新安装。");
  }
  if (report.degradation !== undefined && report.degradation.length > 0) {
    lines.push(`降级说明：${report.degradation}`);
  }
  lines.push(
    kind === "openclaw"
      ? "OpenClaw 迁移提示：metadata.openclaw.requires 已转换为 opencolorful.requires（仅依赖提示，不产生 Grant）；network:true 只记录降级，绝不授予网络权限。"
      : "Hermes 迁移提示：platform/prerequisites/required_environment(_variables) 已转换为 opencolorful.requires（仅依赖提示，不产生 Grant）；skills_list/skill_view 渐进披露由平台 search/inspect 承载。",
  );
  return lines.join("");
}

/**
 * 生态适配器安装边界（fail-closed）：
 * - unsupported / metadata-only / 无法解析 → 拒绝安装并给迁移建议（不生成空壳）；
 * - 存在"未转换的硬性字段"（os:xxx 无法映射、未知高风险字段等）→ 拒绝并给建议；
 * - 只有生态描述性元数据被标记（metadata.openclaw.* / metadata.hermes.*）→
 *   可安装（诊断保留在兼容报告中展示），避免真实生态包被误杀。
 * 返回迁移建议文本（供诊断展示）。
 */
export function assertEcoInstallable(kind: EcosystemSkillKind, report: SkillCompatibilityReport | null): string {
  const advice = migrationAdviceFor(kind, report);
  if (report === null) {
    throw new SkillSourceError("skill_package_invalid", `该 ${ECOSYSTEM_KIND_LABEL[kind]} 包无法直接安装。${advice}`);
  }
  if (report.level === "unsupported" || report.level === "metadata-only") {
    throw new SkillSourceError("skill_package_invalid", `该 ${ECOSYSTEM_KIND_LABEL[kind]} 包无法直接安装（${report.level}）。${advice}`);
  }
  const benign = BENIGN_ECO_MISSING[kind];
  const blockers = report.missing.filter((key) => !benign.test(key));
  if (blockers.length > 0) {
    throw new SkillSourceError(
      "skill_package_invalid",
      `该 ${ECOSYSTEM_KIND_LABEL[kind]} 包存在未转换的兼容字段（${blockers.slice(0, 8).join("、")}${blockers.length > 8 ? " 等" : ""}）。${advice}`,
    );
  }
  return advice;
}

/** 把生态包校验/暂存失败包装为带迁移建议的稳定错误（保留原 reasonCode）。 */
export function wrapEcoStageError(kind: EcosystemSkillKind, error: unknown, report: SkillCompatibilityReport | null): SkillSourceError {
  if (error instanceof SkillSourceError) {
    const advice = migrationAdviceFor(kind, report);
    return new SkillSourceError(error.code, `${error.message}。迁移建议：${advice}`, error.detail);
  }
  const code: SkillErrorCode = "skill_package_invalid";
  return new SkillSourceError(code, `该 ${ECOSYSTEM_KIND_LABEL[kind]} 包暂存失败：${error instanceof Error ? error.message : String(error)}。迁移建议：${migrationAdviceFor(kind, report)}`);
}

/** 组装 inspect 阶段的失败诊断（错误信息 + 迁移建议），供适配器错误消息复用。 */
export function ecoErrorWithAdvice(kind: EcosystemSkillKind, reasonCode: SkillErrorCode, message: string, report: SkillCompatibilityReport | null): SkillSourceError {
  return new SkillSourceError(reasonCode, `${message}。迁移建议：${migrationAdviceFor(kind, report)}`);
}

/** 校验器错误 → 迁移建议错误消息（保留 reasonCode，追加建议）。 */
export function ecoValidationError(kind: EcosystemSkillKind, firstError: SkillPackageErrorInfo): SkillSourceError {
  const advice = migrationAdviceFor(kind, null);
  return new SkillSourceError(firstError.reasonCode, `${firstError.message}。迁移建议：${advice}`);
}
