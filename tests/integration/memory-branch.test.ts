import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersistentSession } from "../../src/pi-sdk/index.js";
import { getSessionManager } from "../../src/pi-sdk/session-manager-registry.js";
import {
  entriesAfterEntry,
  extractMessageText,
  isEntryOnBranch,
  readSessionBranchSnapshot,
  sliceBranchRange,
} from "../../src/runtime/memory/jsonl-branch-reader.js";

// ═══════════════════════════════════════════════════════════════
// PI 分支语义集成测试（plans/phase-10.md 第八节 T3 前置）
// 用真实 PI SessionManager 写文件（含 branch() 分叉），验证：
// 1. entry 身份 = (session 文件内 id, parentId 链)；leaf = 文件序最后 entry
// 2. 分支变更 = cursor entry 不再位于当前 leaf→root 路径
// 3. 防御式读取容忍崩溃截断行
// 以上语义验证通过后，cursor 契约（branch_revision + lastEntryId）冻结。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function createSessionDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-branch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("PI JSONL 分支读取（真实 SessionManager 写文件）", () => {
  it("还原 header 与当前分支路径，leaf 为文件序最后 entry", () => {
    const dir = createSessionDir();
    const handle = createPersistentSession(dir, dir, "sess-1");
    handle.appendUserMessage("第一问");
    handle.appendAssistantMessage("第一答");
    handle.appendUserMessage("第二问");
    handle.appendAssistantMessage("第二答");
    handle.persist();

    const snapshot = readSessionBranchSnapshot(handle.path);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.header?.id).toBe("sess-1");
    expect(snapshot?.entries).toHaveLength(4);
    expect(snapshot?.totalEntries).toBe(4);
    expect(snapshot?.droppedLines).toBe(0);

    const roles = snapshot?.entries.map((entry) => extractMessageText(entry)?.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);

    const last = snapshot?.entries[3];
    expect(last).toBeDefined();
    expect(snapshot?.leafId).toBe(last?.id ?? "");
    expect(extractMessageText(last!)?.text).toBe("第二答");
  });

  it("entriesAfterEntry 增量语义与 isEntryOnBranch 成员判定", () => {
    const dir = createSessionDir();
    const handle = createPersistentSession(dir, dir, "sess-2");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.appendUserMessage("u2");
    handle.appendAssistantMessage("a2");
    handle.persist();

    const snapshot = readSessionBranchSnapshot(handle.path);
    expect(snapshot).not.toBeNull();
    const [u1, a1, u2, a2] = snapshot?.entries ?? [];
    for (const entry of [u1, a1, u2, a2]) {
      expect(entry).toBeDefined();
      expect(isEntryOnBranch(snapshot!, entry!.id)).toBe(true);
    }
    expect(isEntryOnBranch(snapshot!, "不存在的id")).toBe(false);

    const after = entriesAfterEntry(snapshot!, a1!.id);
    expect(after?.map((entry) => entry.id)).toEqual([u2!.id, a2!.id]);
    expect(entriesAfterEntry(snapshot!, null)).toHaveLength(4);
    // cursor 不在路径上 → null（调用方视为分支变更）
    expect(entriesAfterEntry(snapshot!, "不存在的id")).toBeNull();
  });

  it("branch() 分叉后：旧分支 entry 离队，cursor 命中即判定分支变更", () => {
    const dir = createSessionDir();
    const handle = createPersistentSession(dir, dir, "sess-3");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.appendUserMessage("u2-old");
    handle.appendAssistantMessage("a2-old");
    handle.persist();

    const before = readSessionBranchSnapshot(handle.path);
    const u1 = before?.entries[0];
    const oldTail = before?.entries[3];
    expect(u1).toBeDefined();
    expect(oldTail).toBeDefined();

    // 从 u1 分叉，写入新分支
    const manager = getSessionManager(handle);
    manager.branch(u1!.id);
    handle.appendUserMessage("u2-new");
    handle.appendAssistantMessage("a2-new");
    handle.persist();

    const after = readSessionBranchSnapshot(handle.path);
    expect(after).not.toBeNull();
    // 全部 6 个 entry 仍在文件中（append-only），但当前分支只有 3 个
    expect(after?.totalEntries).toBe(6);
    expect(after?.entries).toHaveLength(3);
    expect(after?.entries[0]?.id).toBe(u1!.id);
    expect(extractMessageText(after!.entries[1]!)?.text).toBe("u2-new");
    expect(extractMessageText(after!.entries[2]!)?.text).toBe("a2-new");

    // 关键契约：旧分支 tail 不在新路径上 → 以它为 cursor 的调用方必须判定分支变更
    expect(isEntryOnBranch(after!, oldTail!.id)).toBe(false);
    expect(entriesAfterEntry(after!, oldTail!.id)).toBeNull();
    // 分叉点仍在路径上，可做为公共祖先增量起点
    expect(isEntryOnBranch(after!, u1!.id)).toBe(true);
    expect(entriesAfterEntry(after!, u1!.id)).toHaveLength(2);
  });

  it("sliceBranchRange 返回闭区间 entries（recall_session 原文下钻）", () => {
    const dir = createSessionDir();
    const handle = createPersistentSession(dir, dir, "sess-4");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.appendUserMessage("u2");
    handle.appendAssistantMessage("a2");
    handle.persist();

    const snapshot = readSessionBranchSnapshot(handle.path);
    const [, a1, u2, a2] = snapshot?.entries ?? [];
    const slice = sliceBranchRange(snapshot!, a1!.id, u2!.id);
    expect(slice?.map((entry) => entry.id)).toEqual([a1!.id, u2!.id]);
    expect(sliceBranchRange(snapshot!, u2!.id, a1!.id)).toBeNull();
    expect(sliceBranchRange(snapshot!, "不存在", a2!.id)).toBeNull();
  });

  it("容忍崩溃截断的最后一行，不抛错并计数 droppedLines", () => {
    const dir = createSessionDir();
    const handle = createPersistentSession(dir, dir, "sess-5");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.persist();

    fs.appendFileSync(handle.path, '{"type":"message","id":"abcd1234","pare', "utf8");
    const snapshot = readSessionBranchSnapshot(handle.path);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.droppedLines).toBe(1);
    expect(snapshot?.entries).toHaveLength(2);
  });

  it("session 文件不存在时返回 null（未持久化属正常）", () => {
    const dir = createSessionDir();
    expect(readSessionBranchSnapshot(path.join(dir, "不存在.jsonl"))).toBeNull();
  });
});
