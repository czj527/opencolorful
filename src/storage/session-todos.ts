import type Database from "better-sqlite3";

import type { SessionTodoItemView } from "../contracts/events.js";

// ═══════════════════════════════════════════════════════════════
// 波次 B5a：durable session todo 事实表存储（plans/p1-conversation-workbench
// §3.2.5 冻结语义）。
//
// - todos 属于会话（session_id），由 first-party todo_write 工具在 turn 执行
//   内唯一写入（会话单飞已串行化写者）；本 store 不提供任何 UI 写路径；
// - 写语义：整表替换（whole-list replacement）在一个 SQLite 事务内完成
//   （DELETE 全部旧行 + 按 position = 数组下标批量 INSERT）；空列表是合法的
//   显式清空（对齐 OpenCode session/todo.ts 的 update 语义）；
// - status/priority 在触达 DB 之前先按枚举校验（DB CHECK 只是兜底防线）；
// - store 不强制"至多一条 in_progress"（由工具描述向模型提出要求，B0 §3.2.5）；
// - 不允许无界载荷：条目数与文本长度设上限（B5 forbidden: no unbounded
//   arbitrary task payloads）。
// ═══════════════════════════════════════════════════════════════

/** 待办状态枚举（与 migrations v15 session_todos.status CHECK 一致） */
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type SessionTodoStatus = (typeof TODO_STATUSES)[number];

/** 待办优先级枚举（与 migrations v15 session_todos.priority CHECK 一致） */
export const TODO_PRIORITIES = ["high", "medium", "low"] as const;
export type SessionTodoPriority = (typeof TODO_PRIORITIES)[number];

/** 单条待办写入负载（activeForm 可选；与 contracts/events.ts SessionTodoItemView 对齐） */
export interface SessionTodoWriteItem {
  readonly content: string;
  readonly status: SessionTodoStatus;
  readonly priority: SessionTodoPriority;
  readonly activeForm?: string;
}

/** store 层校验/写入失败（reason 为用户可见中文，不含敏感输入） */
export class SessionTodoStoreError extends Error {
  constructor(
    readonly reasonCode: "invalid_input" | "store_failed",
    message: string,
  ) {
    super(message);
    this.name = "SessionTodoStoreError";
  }
}

/** 条目数上限（防无界载荷） */
const MAX_TODO_ITEMS = 100;
/** content 长度上限（防无界载荷） */
const MAX_CONTENT_LENGTH = 2000;
/** activeForm 长度上限（防无界载荷） */
const MAX_ACTIVE_FORM_LENGTH = 200;

interface SessionTodoRow {
  position: number;
  content: string;
  status: string;
  priority: string;
  active_form: string | null;
  updated_at: string;
}

/** 行 → 视图（exactOptionalPropertyTypes：activeForm 缺省时不得带 undefined 键） */
function toView(row: SessionTodoRow): SessionTodoItemView {
  return {
    content: row.content,
    status: row.status as SessionTodoStatus,
    priority: row.priority as SessionTodoPriority,
    ...(row.active_form !== null ? { activeForm: row.active_form } : {}),
  };
}

export class SessionTodoStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 整表替换：一个事务内先 DELETE 该会话全部旧行，再按数组下标写入新列表。
   * 空列表 = 显式清空（只执行 DELETE）。返回写入库后的权威视图列表
   * （position 顺序），供 todo.updated 事件负载与工具结果复用。
   */
  replace(sessionId: string, items: readonly SessionTodoWriteItem[]): SessionTodoItemView[] {
    if (items.length > MAX_TODO_ITEMS) {
      throw new SessionTodoStoreError(
        "invalid_input",
        `待办条目数超过上限（最多 ${MAX_TODO_ITEMS} 条，收到 ${items.length} 条）`,
      );
    }
    // 触达 DB 之前的输入校验（DB CHECK 只是兜底，不作为第一道防线）
    const validated = items.map((item, index) => {
      const where = `第 ${index + 1} 条待办`;
      if (typeof item.content !== "string" || item.content.trim().length === 0) {
        throw new SessionTodoStoreError("invalid_input", `${where}的内容不能为空`);
      }
      if (item.content.length > MAX_CONTENT_LENGTH) {
        throw new SessionTodoStoreError(
          "invalid_input",
          `${where}的内容过长（最多 ${MAX_CONTENT_LENGTH} 字符）`,
        );
      }
      if (!(TODO_STATUSES as readonly string[]).includes(item.status)) {
        throw new SessionTodoStoreError(
          "invalid_input",
          `${where}的状态不受支持（${item.status}）`,
        );
      }
      if (!(TODO_PRIORITIES as readonly string[]).includes(item.priority)) {
        throw new SessionTodoStoreError(
          "invalid_input",
          `${where}的优先级不受支持（${item.priority}）`,
        );
      }
      if (
        item.activeForm !== undefined &&
        (typeof item.activeForm !== "string" || item.activeForm.trim().length === 0)
      ) {
        throw new SessionTodoStoreError("invalid_input", `${where}的进行时短语不能为空`);
      }
      if (item.activeForm !== undefined && item.activeForm.length > MAX_ACTIVE_FORM_LENGTH) {
        throw new SessionTodoStoreError(
          "invalid_input",
          `${where}的进行时短语过长（最多 ${MAX_ACTIVE_FORM_LENGTH} 字符）`,
        );
      }
      return item;
    });

    const now = new Date().toISOString();
    try {
      const replaceAll = this.database.transaction(() => {
        this.database
          .prepare("DELETE FROM session_todos WHERE session_id = ?")
          .run(sessionId);
        if (validated.length === 0) {
          return; // 空列表 = 合法的显式清空
        }
        const insert = this.database.prepare(
          `INSERT INTO session_todos (session_id, position, content, status, priority, active_form, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        validated.forEach((item, position) => {
          insert.run(sessionId, position, item.content, item.status, item.priority, item.activeForm ?? null, now);
        });
      });
      replaceAll();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      // Error cause 透传原始存储错误（中文用户信息不拼接敏感输入）
      const wrapped = new SessionTodoStoreError(
        "store_failed",
        `待办写入失败（存储层已回滚）：${cause.slice(0, 200)}`,
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return validated.map((item) => ({
      content: item.content,
      status: item.status,
      priority: item.priority,
      ...(item.activeForm !== undefined ? { activeForm: item.activeForm } : {}),
    }));
  }

  /** 读取会话待办（position 升序 = 写入时数组顺序）；无待办返回空列表。 */
  list(sessionId: string): SessionTodoItemView[] {
    const rows = this.database
      .prepare(
        `SELECT position, content, status, priority, active_form, updated_at
         FROM session_todos WHERE session_id = ? ORDER BY position ASC`,
      )
      .all(sessionId) as SessionTodoRow[];
    return rows.map(toView);
  }
}
