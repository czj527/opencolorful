import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  branchTo,
  branchToRoot,
  createPersistentSession,
  forkSessionToNewSession,
  getBranchEntries,
  getLeafEntryId,
  getSessionTree,
  openPersistentSession,
  PiSessionTreeError,
  resolveEntry,
} from "../../src/pi-sdk/index.js";

// ═══════════════════════════════════════════════════════════════
// P1 波次B B1：PI 会话树受控适配器测试（plans/p1-conversation-workbench.en.md §3）
// 验证受控原语：getSessionTree / getBranchEntries / resolveEntry / branchTo /
// branchToRoot / getLeafEntryId / forkSessionToNewSession。
// 全部使用临时目录隔离，不触碰真实 Provider 网络；JSONL 均为真实 PI
// SessionManager 语义（append-only、leaf = 文件序最后 entry）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function createSessionDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function userMessage(text: string, timestamp: number) {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number, extraContent: unknown[] = []) {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...extraContent],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function writeSessionFile(sessionFile: string, lines: string[]): void {
  fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
}

function headerLine(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00Z",
    cwd: process.cwd(),
  });
}

function readLines(sessionFile: string): string[] {
  return fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function childIds(node: ReturnType<typeof getSessionTree>[number]): string[] {
  return node.children.map((child) => child.entry.entryId);
}

/**
 * 手工构造多分支会话（确定性 entry id + 时间戳）：
 *   e1(user) ── e2(assistant 含 toolCall) ─┬─ e2r(toolResult, ts 02)
 *                                          ├─ e3(user, ts 03) ── e7(compaction, ts 07)
 *                                          └─ e4(assistant, ts 04)
 *            └─ e5(user, ts 05) ── e6(label → e1, ts 06)
 * 文件序最后 entry = e7 → reopen 后 leaf = e7。
 */
function writeMultiBranchSession(sessionFile: string): void {
  writeSessionFile(sessionFile, [
    headerLine("s-tree"),
    JSON.stringify({
      type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z",
      message: userMessage("第一条提问", 1000000),
    }),
    JSON.stringify({
      type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:01:00Z",
      message: assistantMessage("第一版回答", 1000001, [
        { type: "toolCall", id: "tc-1", name: "ls", arguments: { path: "." } },
      ]),
    }),
    JSON.stringify({
      type: "message", id: "e2r", parentId: "e2", timestamp: "2026-01-01T00:02:00Z",
      message: {
        role: "toolResult", toolCallId: "tc-1", toolName: "ls",
        content: [{ type: "text", text: "file1.txt" }], isError: false, timestamp: 1000002,
      },
    }),
    JSON.stringify({
      type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:03:00Z",
      message: userMessage("追问", 1000003),
    }),
    JSON.stringify({
      type: "message", id: "e4", parentId: "e2", timestamp: "2026-01-01T00:04:00Z",
      message: assistantMessage("兄弟分支回答", 1000004),
    }),
    JSON.stringify({
      type: "message", id: "e5", parentId: "e1", timestamp: "2026-01-01T00:05:00Z",
      message: userMessage("换个话题", 1000005),
    }),
    JSON.stringify({
      type: "label", id: "e6", parentId: "e5", timestamp: "2026-01-01T00:06:00Z",
      targetId: "e1", label: "重要",
    }),
    JSON.stringify({
      type: "compaction", id: "e7", parentId: "e3", timestamp: "2026-01-01T00:07:00Z",
      summary: "压缩摘要", firstKeptEntryId: "e1", tokensBefore: 1000,
    }),
  ]);
}

describe("PI 会话树受控适配器（B1）", () => {
  it("树形：entryId/parentId/子节点次序与条目字段映射（手工多分支会话）", () => {
    const dir = createSessionDir("opencolorful-tree-shape-");
    const sessionFile = path.join(dir, "session.jsonl");
    writeMultiBranchSession(sessionFile);

    const session = openPersistentSession(sessionFile, dir);
    const tree = getSessionTree(session);

    // 唯一根
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.entry.entryId).toBe("e1");
    expect(root.entry.parentId).toBeNull();
    expect(root.entry.type).toBe("message");
    expect(root.entry.role).toBe("user");
    expect(root.entry.text).toBe("第一条提问");
    expect(root.entry.timestamp).toBe("2026-01-01T00:00:00Z");

    // 子节点按时间戳升序：e1 → [e2, e5]
    expect(childIds(root)).toEqual(["e2", "e5"]);
    const e2 = root.children[0]!;
    const e5 = root.children[1]!;
    expect(e2.entry.parentId).toBe("e1");
    expect(e5.entry.parentId).toBe("e1");

    // e2 → [e2r(toolResult), e3, e4]（按时间戳升序）
    expect(childIds(e2)).toEqual(["e2r", "e3", "e4"]);

    // assistant 条目带 toolCalls（与 PiMessageEntry 同一拍平规则：500 字符截断）
    expect(e2.entry.role).toBe("assistant");
    expect(e2.entry.text).toBe("第一版回答");
    expect(e2.entry.toolCalls).toEqual([
      { toolCallId: "tc-1", toolName: "ls", status: "completed", result: "file1.txt" },
    ]);

    // toolResult 条目以自身节点出现，role=toolResult，正文走 500 字符限长约定
    const e2r = e2.children[0]!;
    expect(e2r.entry.type).toBe("message");
    expect(e2r.entry.role).toBe("toolResult");
    expect(e2r.entry.text).toBe("file1.txt");
    expect(e2r.entry.toolCalls).toBeUndefined();

    // label 条目：text = label 文本
    const e6 = e5.children[0]!;
    expect(e6.entry.type).toBe("label");
    expect(e6.entry.text).toBe("重要");

    // compaction 条目：text = summary
    const e3 = e2.children[1]!;
    const e7 = e3.children[0]!;
    expect(e7.entry.type).toBe("compaction");
    expect(e7.entry.text).toBe("压缩摘要");

    // resolveEntry 与树条目一致；叶子 = 文件序最后 entry（e7）
    expect(getLeafEntryId(session)).toBe("e7");
    expect(resolveEntry(session, "e7")?.type).toBe("compaction");
    expect(resolveEntry(session, "不存在的id")).toBeUndefined();

    session.dispose();
  });

  it("getBranchEntries：根→叶顺序、缺省当前叶子、未知 id 抛 entry_not_found", () => {
    const dir = createSessionDir("opencolorful-tree-branch-");
    const sessionFile = path.join(dir, "session.jsonl");
    writeMultiBranchSession(sessionFile);

    const session = openPersistentSession(sessionFile, dir);
    const ids = (from?: string) => getBranchEntries(session, from).map((entry) => entry.entryId);

    // 缺省：从当前叶子（e7）回溯到根
    expect(ids()).toEqual(["e1", "e2", "e3", "e7"]);
    // 指定条目：从该条目回溯到根
    expect(ids("e4")).toEqual(["e1", "e2", "e4"]);
    expect(ids("e1")).toEqual(["e1"]);
    // 未知 id → 类型化错误
    expect(() => ids("不存在")).toThrow(PiSessionTreeError);
    try {
      ids("不存在");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PiSessionTreeError);
      expect((error as PiSessionTreeError).code).toBe("entry_not_found");
      expect((error as Error).message).toContain("会话条目不存在");
    }

    session.dispose();
  });

  it("branchTo + append 形成兄弟分支；旧分支条目不变（append-only JSONL 佐证）", () => {
    const dir = createSessionDir("opencolorful-tree-sibling-");
    const session = createPersistentSession(dir, dir, "sess-branch");
    session.appendUserMessage("问题一");
    session.appendAssistantMessage("回答一");

    const sessionFile = session.path;
    const bytesBefore = fs.readFileSync(sessionFile, "utf8");
    const branchEntries = getBranchEntries(session);
    const u1 = branchEntries[0]!;
    const a1 = branchEntries[1]!;

    // 从第一条用户消息分叉：仅移动叶子指针
    branchTo(session, u1.entryId);
    expect(getLeafEntryId(session)).toBe(u1.entryId);

    session.appendUserMessage("问题一（重试）");
    session.appendAssistantMessage("回答一（重试）");

    // append-only 佐证：分叉后的两次 append 只在文件尾部追加，原字节是前缀
    const bytesAfter = fs.readFileSync(sessionFile, "utf8");
    expect(bytesAfter.startsWith(bytesBefore)).toBe(true);
    expect(readLines(sessionFile)).toHaveLength(5); // header + 4 entries

    // 树形：u1 现在有两个子分支（旧 a1 与新 u2）
    const tree = getSessionTree(session);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(childIds(root)).toEqual([a1.entryId, root.children[1]!.entry.entryId]);
    expect(root.children[1]!.entry.role).toBe("user");
    expect(root.children[1]!.entry.text).toBe("问题一（重试）");

    // 当前分支 = 新分支；旧分支原样保留
    expect(getLeafEntryId(session)).toBe(root.children[1]!.children[0]!.entry.entryId);
    expect(getBranchEntries(session).map((entry) => entry.text)).toEqual([
      "问题一",
      "问题一（重试）",
      "回答一（重试）",
    ]);
    expect(getBranchEntries(session, a1.entryId).map((entry) => entry.text)).toEqual([
      "问题一",
      "回答一",
    ]);
    expect(resolveEntry(session, a1.entryId)?.text).toBe("回答一");

    session.dispose();
  });

  it("branchToRoot：下一次 append 成为新根；getTree 出现两个根", () => {
    const dir = createSessionDir("opencolorful-tree-root-");
    const session = createPersistentSession(dir, dir, "sess-root");
    session.appendUserMessage("旧根提问");
    session.appendAssistantMessage("旧根回答");

    const a1 = getBranchEntries(session)[1]!;

    branchToRoot(session);
    expect(getLeafEntryId(session)).toBeNull();
    // 叶子为空时缺省分支路径为空
    expect(getBranchEntries(session)).toHaveLength(0);

    session.appendUserMessage("新根提问");
    const tree = getSessionTree(session);
    expect(tree).toHaveLength(2);
    const newRoot = tree[1]!;
    expect(newRoot.entry.parentId).toBeNull();
    expect(newRoot.entry.role).toBe("user");
    expect(newRoot.entry.text).toBe("新根提问");
    expect(getLeafEntryId(session)).toBe(newRoot.entry.entryId);
    expect(getBranchEntries(session).map((entry) => entry.entryId)).toEqual([newRoot.entry.entryId]);

    // 旧分支原样保留
    expect(getBranchEntries(session, a1.entryId).map((entry) => entry.text)).toEqual([
      "旧根提问",
      "旧根回答",
    ]);

    session.dispose();
  });

  it("forkSessionToNewSession：新 id/新文件/仅含目标路径/header 指向源文件/源文件字节不变", () => {
    const dir = createSessionDir("opencolorful-tree-fork-");
    const sourceFile = path.join(dir, "source-session.jsonl");
    writeSessionFile(sourceFile, [
      headerLine("s-src"),
      JSON.stringify({
        type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z",
        message: userMessage("根提问", 1000000),
      }),
      JSON.stringify({
        type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:01:00Z",
        message: assistantMessage("回答 v1", 1000001),
      }),
      JSON.stringify({
        type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:02:00Z",
        message: userMessage("追问", 1000002),
      }),
      JSON.stringify({
        type: "message", id: "e4", parentId: "e3", timestamp: "2026-01-01T00:03:00Z",
        message: assistantMessage("回答 v2", 1000003),
      }),
      JSON.stringify({
        type: "message", id: "e5", parentId: "e1", timestamp: "2026-01-01T00:04:00Z",
        message: userMessage("重试提问", 1000004),
      }),
      JSON.stringify({
        type: "message", id: "e6", parentId: "e5", timestamp: "2026-01-01T00:05:00Z",
        message: assistantMessage("回答 v1-retry", 1000005),
      }),
    ]);
    const sourceBytesBefore = fs.readFileSync(sourceFile, "utf8");

    // 1) 指定目标条目 e3：新会话只包含根→e3 路径
    const fork = forkSessionToNewSession(sourceFile, "e3", dir);
    expect(fork.sessionId).not.toBe("s-src");
    expect(fork.sessionPath).not.toBe(sourceFile);
    // PI 事实：新文件写在源文件同目录（open 实例的 sessionDir = 源文件父目录）
    expect(path.dirname(fork.sessionPath)).toBe(path.dirname(sourceFile));
    expect(fs.existsSync(fork.sessionPath)).toBe(true);

    const forkLines = readLines(fork.sessionPath);
    const forkHeader = JSON.parse(forkLines[0]!) as {
      type: string; id: string; cwd: string; parentSession?: string;
    };
    expect(forkHeader.type).toBe("session");
    expect(forkHeader.id).toBe(fork.sessionId);
    expect(forkHeader.cwd).toBe(dir);
    expect(forkHeader.parentSession).toBe(path.resolve(sourceFile));
    const forkEntryIds = forkLines.slice(1).map((line) => (JSON.parse(line) as { id: string }).id);
    expect(forkEntryIds).toEqual(["e1", "e2", "e3"]);

    const forkedSession = openPersistentSession(fork.sessionPath, path.dirname(fork.sessionPath), dir);
    expect(getLeafEntryId(forkedSession)).toBe("e3");
    expect(getBranchEntries(forkedSession).map((entry) => entry.entryId)).toEqual(["e1", "e2", "e3"]);
    forkedSession.dispose();

    // 2) 源文件字节不变
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceBytesBefore);

    // 3) 缺省目标 = 文件序最后 entry（e6）
    const forkDefault = forkSessionToNewSession(sourceFile, null, dir);
    const defaultEntryIds = readLines(forkDefault.sessionPath)
      .slice(1)
      .map((line) => (JSON.parse(line) as { id: string }).id);
    expect(defaultEntryIds).toEqual(["e1", "e5", "e6"]);

    // 4) 未知目标条目 → entry_not_found
    expect(() => forkSessionToNewSession(sourceFile, "不存在", dir)).toThrow(PiSessionTreeError);
    try {
      forkSessionToNewSession(sourceFile, "不存在", dir);
      expect.unreachable();
    } catch (error) {
      expect((error as PiSessionTreeError).code).toBe("entry_not_found");
    }

    // 5) 空源（只有 header）→ invalid_target，且源文件不变
    const emptyFile = path.join(dir, "empty-session.jsonl");
    writeSessionFile(emptyFile, [headerLine("s-empty")]);
    const emptyBytesBefore = fs.readFileSync(emptyFile, "utf8");
    expect(() => forkSessionToNewSession(emptyFile, null, dir)).toThrow(PiSessionTreeError);
    try {
      forkSessionToNewSession(emptyFile, null, dir);
      expect.unreachable();
    } catch (error) {
      expect((error as PiSessionTreeError).code).toBe("invalid_target");
    }
    expect(fs.readFileSync(emptyFile, "utf8")).toBe(emptyBytesBefore);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceBytesBefore);
  });

  it("重启/重开后 leaf = 文件序最后 entry（B0 §3.2.3 持久化规则前提的行为佐证）", () => {
    const dir = createSessionDir("opencolorful-tree-reopen-");
    const session = createPersistentSession(dir, dir, "sess-reopen");
    session.appendUserMessage("原始提问");
    session.appendAssistantMessage("原始回答");

    const u1 = getBranchEntries(session)[0]!;
    branchTo(session, u1.entryId);
    session.appendUserMessage("重试提问");
    session.appendAssistantMessage("重试回答");

    const beforeReopen = getBranchEntries(session);
    const a2 = beforeReopen[beforeReopen.length - 1]!;
    expect(beforeReopen.map((entry) => entry.entryId)).toHaveLength(3);

    session.dispose();

    // 重开：PI _buildIndex 把 leaf 置为文件序最后 entry —— 即重生分支的尾部
    const reopened = openPersistentSession(session.path, dir, dir);
    expect(getLeafEntryId(reopened)).toBe(a2.entryId);
    expect(getBranchEntries(reopened).map((entry) => entry.entryId)).toEqual([
      u1.entryId,
      beforeReopen[1]!.entryId,
      a2.entryId,
    ]);
    reopened.dispose();
  });

  it("PI import 边界：src/ 下只有 src/pi-sdk 允许 import @earendil-works", () => {
    const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'](@earendil-works\/pi-[^"']+)["']/g;
    const violations: string[] = [];
    let scanned = 0;

    const walk = (current: string): void => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        const itemPath = path.join(current, item.name);
        if (item.isDirectory()) {
          walk(itemPath);
          continue;
        }
        if (!item.name.endsWith(".ts")) continue;
        if (itemPath.startsWith(path.join(srcRoot, "pi-sdk") + path.sep)) continue;
        scanned += 1;
        const source = fs.readFileSync(itemPath, "utf8");
        if (importPattern.test(source)) {
          violations.push(path.relative(srcRoot, itemPath));
        }
        importPattern.lastIndex = 0;
      }
    };

    walk(srcRoot);
    expect(violations).toEqual([]);
    expect(scanned).toBeGreaterThan(10); // 佐证扫描确实覆盖了 src/
  });
});
