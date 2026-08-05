import Value from "typebox/value";

import { SkillRefSchema, type SkillErrorCode, type SkillRef } from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill 领域错误（plans/phase-13.md §7 / §8）
//
// - 所有失败路径 fail-closed：不允许用 undefined/空成功表示"已发现/已解析"；
// - 稳定 reasonCode 来自冻结的 SKILL_ERROR_CODES，跨进程诊断不暴露内部细节；
// - 跨函数边界输入（SkillRef 等）必须先过冻结 Schema 再使用。
// ═══════════════════════════════════════════════════════════════

/** 领域错误：校验器 / Catalog / Resolver 统一抛出，reasonCode 来自冻结枚举。 */
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  readonly detail?: string;

  constructor(code: SkillErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/** 来源适配器错误：discover/inspect/stage/resolveVersion 失败时抛出。 */
export class SkillSourceError extends SkillError {
  constructor(code: SkillErrorCode, message: string, detail?: string) {
    super(code, message, detail);
    this.name = "SkillSourceError";
  }
}

/** 显式断言：跨函数边界传入的 SkillRef 必须通过冻结 Schema（fail-closed）。 */
export function assertSkillRef(input: unknown): SkillRef {
  if (!Value.Check(SkillRefSchema, input)) {
    throw new SkillError("skill_unknown_skillref", "SkillRef 格式非法（来源/版本/哈希必须精确）");
  }
  return input as SkillRef;
}
