import path from "node:path";

import { ALLOWED_SKILL_FILE_EXTENSIONS, DENIED_SKILL_FILE_EXTENSIONS } from "../validator.js";
import { walkSafeFiles } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 Skill 包风险标记（plans/phase-13.md §12.2 / §12.4）
//
// - 确定性检查优先：脚本目录 / 二进制 / 未知文件类型都是结构风险；
// - scripts 只做"显著风险提示"（进 inspect 结果），不阻断安装；
// - binary / 未知文件类型会被 validator 拒绝（fail-closed），这里同步标记；
// - 标记绝不产生任何授权（脚本仍只能走 Sandbox）。
// ═══════════════════════════════════════════════════════════════

export const SKILL_RISK_CODES = ["scripts", "binary", "unknown-file-type"] as const;
export type SkillRiskCode = (typeof SKILL_RISK_CODES)[number];

export interface SkillRiskMarker {
  readonly code: SkillRiskCode;
  readonly message: string;
  readonly path?: string;
}

const DENIED = DENIED_SKILL_FILE_EXTENSIONS;
const ALLOWED = ALLOWED_SKILL_FILE_EXTENSIONS;

/** 结构风险标记：scripts/ 目录、二进制、未知文件类型（best-effort 扫描）。 */
export function assessPackageRisks(packageRoot: string): readonly SkillRiskMarker[] {
  const risks: SkillRiskMarker[] = [];
  let entries;
  try {
    entries = walkSafeFiles(packageRoot);
  } catch {
    // 遍历失败（symlink/非常规文件）由 validator 的 errors 表达，风险标记让位于校验错误
    return risks;
  }
  if (entries.some((entry) => entry.rel.startsWith("scripts/"))) {
    risks.push({ code: "scripts", message: "包含 scripts/ 目录：脚本只能经现有 Sandbox 入口执行，安装器绝不运行来源脚本" });
  }
  for (const entry of entries) {
    const extension = path.extname(entry.rel).toLowerCase();
    if (extension !== "" && DENIED.has(extension)) {
      risks.push({ code: "binary", message: `包含禁止的二进制/本地可执行文件（${extension}），默认拒绝安装，建议转换为 Plugin`, path: entry.rel });
    } else if (extension !== "" && !ALLOWED.has(extension)) {
      risks.push({ code: "unknown-file-type", message: `包含未允许的文件类型（${extension}），默认拒绝安装`, path: entry.rel });
    }
  }
  return risks;
}
