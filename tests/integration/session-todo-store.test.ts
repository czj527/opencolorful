import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  SessionTodoStore,
  SessionTodoStoreError,
} from "../../src/storage/session-todos.js";
import type { SessionTodoWriteItem } from "../../src/storage/session-todos.js";

// ═══════════════════════════════════════════════════════════════
// 波次 B5a：SessionTodoStore 存储契约（plans/p1-conversation-workbench §3.2.5）
// 整表替换在单事务内完成；空列表 = 合法显式清空；status/priority 在触达
// DB 之前按枚举校验；DB CHECK 是兜底防线（原始 SQL 插入坏值必须被拒绝）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-todo-store-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { dir, paths, database, store: new SessionTodoStore(database) };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

const item = (
  content: string,
  status: SessionTodoWriteItem["status"] = "pending",
  priority: SessionTodoWriteItem["priority"] = "medium",
  activeForm?: string,
): SessionTodoWriteItem => ({
  content,
  status,
  priority,
  ...(activeForm !== undefined ? { activeForm } : {}),
});

describe("SessionTodoStore 整表替换契约", () => {
  it("replace + list：position 升序 = 写入数组顺序，activeForm 可选字段按需返回", () => {
    const { store } = createStore();
    const stored = store.replace("sess-1", [
      item("第一件事", "in_progress", "high", "正在做第一件事"),
      item("第二件事", "pending", "low"),
      item("第三件事", "completed", "medium"),
    ]);

    expect(stored.map((t) => t.content)).toEqual(["第一件事", "第二件事", "第三件事"]);
    expect(stored[0]).toEqual({
      content: "第一件事",
      status: "in_progress",
      priority: "high",
      activeForm: "正在做第一件事",
    });
    // 无 activeForm 的条目不得携带 undefined 键（exactOptionalPropertyTypes 契约）
    expect(Object.hasOwn(stored[1]!, "activeForm")).toBe(false);

    const listed = store.list("sess-1");
    expect(listed).toEqual(stored);
    // 读取顺序与写入数组顺序一致（position = 数组下标）
    expect(listed.map((t) => t.priority)).toEqual(["high", "low", "medium"]);
  });

  it("整表替换覆盖旧列表：尺寸与内容完全按新列表重建", () => {
    const { store } = createStore();
    store.replace("sess-1", [
      item("旧一", "pending", "high"),
      item("旧二", "pending", "high"),
      item("旧三", "pending", "high"),
    ]);
    store.replace("sess-1", [item("新一", "in_progress", "low", "正在处理新一")]);

    const listed = store.list("sess-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      content: "新一",
      status: "in_progress",
      priority: "low",
      activeForm: "正在处理新一",
    });
    // 其他会话不受影响
    store.replace("sess-2", [item("别的会话", "pending", "high")]);
    expect(store.list("sess-1")).toHaveLength(1);
    expect(store.list("sess-2")).toHaveLength(1);
  });

  it("空列表 = 合法的显式清空（只删不插，幂等）", () => {
    const { store } = createStore();
    store.replace("sess-1", [item("待清除", "pending", "high")]);
    expect(store.list("sess-1")).toHaveLength(1);

    const cleared = store.replace("sess-1", []);
    expect(cleared).toEqual([]);
    expect(store.list("sess-1")).toEqual([]);

    // 清空后再清空仍然成功（幂等）
    expect(store.replace("sess-1", [])).toEqual([]);
    expect(store.list("sess-1")).toEqual([]);
  });

  it("非法 status 在触达 DB 之前被 store 拒绝（中文原因），数据不变", () => {
    const { store } = createStore();
    store.replace("sess-1", [item("既有待办", "pending", "high")]);

    expect(() =>
      store.replace("sess-1", [item("坏状态", "doing" as SessionTodoWriteItem["status"], "high")]),
    ).toThrow(SessionTodoStoreError);
    try {
      store.replace("sess-1", [item("坏状态", "doing" as SessionTodoWriteItem["status"], "high")]);
    } catch (error) {
      expect((error as SessionTodoStoreError).reasonCode).toBe("invalid_input");
      expect((error as Error).message).toContain("状态不受支持");
    }
    // store 数据未被部分写入（校验先于事务）
    expect(store.list("sess-1")).toEqual([
      { content: "既有待办", status: "pending", priority: "high" },
    ]);
  });

  it("非法 priority 被拒绝；空 content / 超长载荷被拒绝（防无界任务载荷）", () => {
    const { store } = createStore();
    expect(() =>
      store.replace("sess-1", [item("坏优先级", "pending", "urgent" as SessionTodoWriteItem["priority"])]),
    ).toThrow(/优先级不受支持/);
    expect(() => store.replace("sess-1", [item("  ", "pending", "high")])).toThrow(/内容不能为空/);
    expect(() =>
      store.replace("sess-1", [item("x".repeat(2001), "pending", "high")]),
    ).toThrow(/内容过长/);
    expect(() =>
      store.replace("sess-1", Array.from({ length: 101 }, (_, i) => item(`任务${i}`))),
    ).toThrow(/条目数超过上限/);
    expect(() =>
      store.replace("sess-1", [item("有短语", "in_progress", "high", " ")]),
    ).toThrow(/进行时短语不能为空/);
    expect(store.list("sess-1")).toEqual([]);
  });

  it("updated_at 为 ISO 时间戳且同一次写入共享", () => {
    const { database, store } = createStore();
    const before = new Date().toISOString();
    store.replace("sess-1", [item("A", "pending", "high"), item("B", "pending", "low")]);
    const after = new Date().toISOString();
    const rows = database
      .prepare("SELECT updated_at FROM session_todos WHERE session_id = ? ORDER BY position")
      .all("sess-1") as Array<{ updated_at: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Number.isNaN(Date.parse(row.updated_at))).toBe(false);
      expect(row.updated_at >= before).toBe(true);
      expect(row.updated_at <= after).toBe(true);
    }
    expect(rows[0]!.updated_at).toBe(rows[1]!.updated_at);
  });

  it("DB CHECK 兜底防线：绕过 store 的原始 SQL 写坏值必须被 SQLite 拒绝（一次性证明）", () => {
    const { database } = createStore();
    expect(() =>
      database
        .prepare(
          "INSERT INTO session_todos (session_id, position, content, status, priority, active_form, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("sess-raw", 0, "绕过校验的坏状态", "bogus", "high", null, new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      database
        .prepare(
          "INSERT INTO session_todos (session_id, position, content, status, priority, active_form, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("sess-raw", 0, "绕过校验的坏优先级", "pending", "urgent", null, new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
  });
});
