/**
 * 波次 B2：会话分支 / 重生成 / Fork 的共享契约类型与稳定错误码。
 *
 * 错误语义对齐 plans/p1-conversation-workbench.en.md §3.4 冻结矩阵：
 * - not_found    → HTTP 404 NOT_FOUND   引用的会话节点不存在，请刷新后重试
 * - invalid_input→ HTTP 400 INVALID_INPUT specific Chinese message
 * - busy         → HTTP 409 SESSION_BUSY 会话正在运行，请先停止后再操作
 * - conflict     → HTTP 409 CONFLICT     会话已归档
 */
export type { SessionBranchesChangedReason } from "./events.js";

export type SessionBranchErrorCode = "not_found" | "invalid_input" | "busy" | "conflict";

export class SessionBranchError extends Error {
  readonly code: SessionBranchErrorCode;

  constructor(code: SessionBranchErrorCode, message: string) {
    super(message);
    this.name = "SessionBranchError";
    this.code = code;
  }
}

/** GET /api/sessions/:id/tree 的单个分支摘要（branchId = 叶子条目 id，§3.1） */
export interface SessionBranchSummary {
  readonly branchId: string;
  readonly leafEntryId: string;
  /** 叶子条目正文预览（~80 字符截断，只读元数据不含完整正文） */
  readonly leafPreview: string;
  /** 根→叶路径上的条目数 */
  readonly entryCount: number;
  /** 叶子条目时间戳（ISO 字符串，来自 PI JSONL） */
  readonly updatedAt: string;
  readonly isCurrent: boolean;
}

/** GET /api/sessions/:id/tree 响应体 */
export interface SessionTreeView {
  readonly currentBranchId: string | null;
  readonly branches: readonly SessionBranchSummary[];
}

/**
 * GET /api/sessions/:id/entries 的单条目视图：分支路径（根→叶）上的受控条目，
 * 附加导航用 turnId（`turn-<userEntryId>`，§3.1；首个用户消息之前的条目为 null）。
 */
export interface SessionEntryView {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly turnId: string | null;
  readonly type: string;
  readonly role?: "user" | "assistant" | "toolResult";
  readonly text: string;
  readonly timestamp: string;
  readonly toolCalls?: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "completed" | "error";
    readonly result?: string;
  }[];
}

/** GET /api/sessions/:id/entries 响应体 */
export interface SessionEntriesView {
  readonly branchId: string | null;
  readonly currentBranchId: string | null;
  readonly entries: readonly SessionEntryView[];
}
