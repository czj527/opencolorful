import type { SubagentErrorCode } from "../../../contracts/subagents.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：Subagent Stores 稳定错误（plans/phase-14.md §22.3）
//
// 所有 Store 失败统一抛 SubagentStoreError（携带 T1 冻结的稳定错误码），
// 调用方（T4-T6）不得依赖 better-sqlite3 原生错误码或错误消息文本。
// 错误码映射（T1 契约逐字）：
// - subagent_not_found           查找不存在
// - subagent_ownership_denied    §22.1 跨 Agent/Session 归属拒绝
// - subagent_run_state_conflict  状态机非法转换 / 同 Thread 非终态唯一冲突
// - subagent_thread_state_conflict closed/closing 上不允许的操作
// - subagent_operation_failed    Envelope/Result/Limits 校验失败、约束冲突等
// - subagent_result_not_reported succeeded 终态缺少 SubagentResultV1
// ═══════════════════════════════════════════════════════════════

export class SubagentStoreError extends Error {
  readonly code: SubagentErrorCode;

  constructor(code: SubagentErrorCode, message: string) {
    super(message);
    this.name = "SubagentStoreError";
    this.code = code;
  }
}
