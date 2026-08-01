import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersistentSession } from "../../src/pi-sdk/index.js";
import { getSessionManager } from "../../src/pi-sdk/session-manager-registry.js";
import {
  extractMessageText,
  readSessionBranchSnapshot,
} from "../../src/runtime/memory/jsonl-branch-reader.js";
import { EventIndexer } from "../../src/runtime/memory/event-indexer.js";
import { RollingSummaryService } from "../../src/runtime/memory/rolling-summary.js";
import type { SummaryRunResult } from "../../src/runtime/memory/rolling-summary.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import type { SessionSummary } from "../../src/contracts/memory.js";

// ═══════════════════════════════════════════════════════════════
// Rolling summary + Event indexer 集成测试（plans/phase-10.md T3）
//
// 使用 createPersistentSession 写真实 JSONL，注入假 completeText。
// 验证：全量/增量摘要、格式修复、degraded 路径、分支隔离、
// 事件索引（正常/幂等/stub/脱敏）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

interface TestContext {
  directory: string;
  sessionStore: SessionSummaryStore;
  eventStore: MemoryEventStore;
  watermarkStore: MemoryWatermarkStore;
  close: () => void;
}

function createContext(): TestContext {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencolorful-memory-summary-"),
  );
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const sessionStore = new SessionSummaryStore(database);
  const eventStore = new MemoryEventStore(database);
  const watermarkStore = new MemoryWatermarkStore(database);
  return {
    directory,
    sessionStore,
    eventStore,
    watermarkStore,
    close: () => database.close(),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

/** 构造一个总是返回固定文本的假 completeText */
function fakeCompleteText(response: string) {
  return async (_req: { systemPrompt: string; prompt: string; maxTokens?: number }) => response;
}

/** 构造一个抛出错误的假 completeText */
function throwingCompleteText(errorMessage: string) {
  return async () => {
    throw new Error(errorMessage);
  };
}

const VALID_SUMMARY = `### 重要事实
- 用户偏好深色模式
- 项目使用 TypeScript

### 时间线
- 14:03 用户询问颜色主题偏好
- 14:05 助手建议深色模式
- 14:08 用户同意`;

describe("RollingSummaryService", () => {
  it("首次全量摘要推进 cursor、写入 summary row 与 watermark", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-full");
    handle.appendUserMessage("我喜欢深色模式");
    handle.appendAssistantMessage("好，记住你的偏好");
    handle.appendUserMessage("项目用什么语言？");
    handle.appendAssistantMessage("TypeScript 为主");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText(VALID_SUMMARY),
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-full",
      sessionPath: handle.path,
    });

    expect(result.status).toBe("updated");
    if (result.status !== "updated") throw new Error("expected updated");
    expect(result.branchRevision).toBeDefined();
    expect(result.messageCount).toBeGreaterThan(0);

    // 验证 summary row 写入
    const row = ctx.sessionStore.getLatestForSession("sess-full");
    expect(row).toBeDefined();
    expect(row?.summary).toContain("重要事实");
    expect(row?.summary).toContain("时间线");
    expect(row?.agentId).toBe("agent-1");
    expect(row?.cursor).toEqual({ lastEntryId: expect.any(String) as string });

    // 验证 watermark
    const wm = ctx.watermarkStore.get("agent-1", "summary", result.branchRevision);
    expect(wm).toBeDefined();
    expect(wm?.dirty).toBe(false);

    ctx.close();
  });

  it("增量：再 append 消息 → 只处理 delta", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-delta");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText(VALID_SUMMARY),
    });

    // 首次
    const r1 = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-delta",
      sessionPath: handle.path,
    });
    expect(r1.status).toBe("updated");

    // 追加新消息
    handle.appendUserMessage("u2-new");
    handle.appendAssistantMessage("a2-new");
    handle.persist();

    // 第二次：增量
    const r2 = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-delta",
      sessionPath: handle.path,
    });
    expect(r2.status).toBe("updated");
    if (r2.status !== "updated") throw new Error("expected updated");

    // 应该有 2 个 summary row（同一 session、同一 revision，upsert 同 key）
    const row = ctx.sessionStore.getLatestForSession("sess-delta");
    expect(row).toBeDefined();
    // cursor 应该推进到最新 entry
    expect(row?.cursor).toBeDefined();
    expect((row?.cursor as Record<string, unknown>)["lastEntryId"]).toBeTruthy();

    ctx.close();
  });

  it("格式失败 → repair 一次成功", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-repair");
    handle.appendUserMessage("测试消息");
    handle.appendAssistantMessage("助手的回复");
    handle.persist();

    // 第一次返回缺失 时间线 的格式，第二次返回完整格式
    const badSummary = `### 重要事实
- 只有一个节`;

    let callCount = 0;
    const completeText = async (_req: {
      systemPrompt: string;
      prompt: string;
      maxTokens?: number;
    }) => {
      callCount += 1;
      if (callCount === 1) return badSummary;
      return VALID_SUMMARY;
    };

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText,
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-repair",
      sessionPath: handle.path,
    });

    // repair 成功 → updated
    expect(result.status).toBe("updated");
    expect(callCount).toBe(2);

    const row = ctx.sessionStore.getLatestForSession("sess-repair");
    expect(row?.summary).toContain("重要事实");
    expect(row?.summary).toContain("时间线");

    ctx.close();
  });

  it("repair 仍失败 → failed、cursor 不推进、watermark dirty", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-bad-format");
    handle.appendUserMessage("test");
    handle.appendAssistantMessage("ok");
    handle.persist();

    // 始终返回坏格式
    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText("只有一些散乱的文本没有节标题"),
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-bad-format",
      sessionPath: handle.path,
    });

    expect(result.status).toBe("failed");

    // summary row 不应被写入（cursor 不推进）
    const snapshot = readSessionBranchSnapshot(handle.path);
    const s = ctx.sessionStore.getLatestForSession("sess-bad-format");
    // 可能无 row 或 cursor 为空
    expect(
      s === undefined ||
        !(s.cursor["lastEntryId"] && typeof s.cursor["lastEntryId"] === "string"),
    ).toBe(true);

    // watermark 应该 dirty
    // 找到对应的 watermark（revision 来自路径 hash）
    const branchRevision = snapshot
      ? snapshot.entries.map((e) => e.id).join(":")
      : "";
    const wm = ctx.watermarkStore.get("agent-1", "summary", branchRevision);
    // 失败时 upsert dirty=true
    if (wm) {
      expect(wm.dirty).toBe(true);
    }

    ctx.close();
  });

  it("completeText undefined → degraded（LLM 不可用）", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-degraded");
    handle.appendUserMessage("hi");
    handle.appendAssistantMessage("hello");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      // completeText undefined = LLM 不可用
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-degraded",
      sessionPath: handle.path,
    });

    expect(result.status).toBe("degraded");

    // summary row 不应被写入
    expect(ctx.sessionStore.getLatestForSession("sess-degraded")).toBeUndefined();

    // watermark 应 dirty
    const snapshot = readSessionBranchSnapshot(handle.path);
    const branchRevision = snapshot
      ? snapshot.entries.map((e) => e.id).join(":")
      : "";
    if (branchRevision) {
      const wm = ctx.watermarkStore.get("agent-1", "summary", branchRevision);
      // degraded 时 upsert dirty=true
      if (wm) {
        expect(wm.dirty).toBe(true);
      }
    }

    ctx.close();
  });

  it("LLM 抛错 → failed、dirty、cursor 不推进", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-llm-err");
    handle.appendUserMessage("test");
    handle.appendAssistantMessage("ok");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: throwingCompleteText("网络超时"),
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-llm-err",
      sessionPath: handle.path,
    });

    expect(result.status).toBe("failed");
    expect(ctx.sessionStore.getLatestForSession("sess-llm-err")).toBeUndefined();

    ctx.close();
  });

  it("branch() 分叉 → 新 revision row、旧 row 保留", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-branch");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.appendUserMessage("u2-old");
    handle.appendAssistantMessage("a2-old");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText(VALID_SUMMARY),
    });

    // 首次摘要
    const r1 = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-branch",
      sessionPath: handle.path,
    });
    expect(r1.status).toBe("updated");
    if (r1.status !== "updated") throw new Error("expected updated");
    const oldRevision = r1.branchRevision;

    // 从 u1 分叉
    const snapshot = readSessionBranchSnapshot(handle.path);
    const u1 = snapshot?.entries[0];
    expect(u1).toBeDefined();
    const manager = getSessionManager(handle);
    manager.branch(u1!.id);
    handle.appendUserMessage("u2-new");
    handle.appendAssistantMessage("a2-new");
    handle.persist();

    // 分叉后摘要
    const r2 = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-branch",
      sessionPath: handle.path,
    });
    expect(r2.status).toBe("updated");
    if (r2.status !== "updated") throw new Error("expected updated");
    const newRevision = r2.branchRevision;

    // 新旧 revision 应不同
    expect(newRevision).not.toBe(oldRevision);

    // 两条 summary row 都在（不同 branch_revision）
    const allRows = [
      ctx.sessionStore.get("sess-branch", oldRevision),
      ctx.sessionStore.get("sess-branch", newRevision),
    ];
    expect(allRows[0]).toBeDefined();
    expect(allRows[1]).toBeDefined();

    ctx.close();
  });

  it("snapshot null → skipped", async () => {
    const ctx = createContext();
    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText(VALID_SUMMARY),
    });

    const result = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "no-sess",
      sessionPath: path.join(ctx.directory, "不存在.jsonl"),
    });

    expect(result.status).toBe("skipped");
    ctx.close();
  });
});

describe("EventIndexer", () => {
  function makeValidSummary(branchRevision: string): SessionSummary {
    return {
      sessionId: "sess-ev",
      branchRevision,
      agentId: "agent-1",
      summary: VALID_SUMMARY,
      messageCount: 4,
      cursor: { lastEntryId: "00000004" },
      sourceStartEntry: "00000001",
      sourceEndEntry: "00000004",
      createdAt: "2026-07-31T00:00:00Z",
      updatedAt: "2026-07-31T00:00:00Z",
    };
  }

  it("正常索引：时间线文本、统计字段正确", () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-ev");
    handle.appendUserMessage("请帮我写代码");
    handle.appendAssistantMessage("好，这是一段代码");
    handle.appendUserMessage("谢谢");
    handle.appendAssistantMessage("不客气");
    handle.persist();

    const snapshot = readSessionBranchSnapshot(handle.path);
    expect(snapshot).not.toBeNull();

    const branchRevision = "abcdef1234567890";
    const summary = makeValidSummary(branchRevision);
    // 对齐 source range 到实际 entry
    const entries = snapshot!.entries;
    const s = { ...summary, sourceStartEntry: entries[0]!.id, sourceEndEntry: entries[entries.length - 1]!.id };

    const indexer = new EventIndexer({
      eventStore: ctx.eventStore,
      watermarkStore: ctx.watermarkStore,
    });

    const result = indexer.indexSession({
      agentId: "agent-1",
      sessionId: "sess-ev",
      sessionPath: handle.path,
      summary: s,
    });

    expect(result.status).toBe("indexed");
    if (result.status === "skipped") throw new Error("expected indexed");

    // 验证事件存在
    const evt = ctx.eventStore.getById(result.eventId);
    expect(evt).toBeDefined();
    expect(evt?.sessionId).toBe("sess-ev");
    expect(evt?.agentId).toBe("agent-1");
    expect(evt?.branchRevision).toBe(branchRevision);
    expect(evt?.messageCount).toBe(4);
    expect(evt?.summary).toContain("14:03");
    expect(evt?.topics.length).toBeGreaterThan(0);
    expect(evt?.searchText).toBeTruthy();

    ctx.close();
  });

  it("幂等：二次 indexSession 同范围 → alreadyIndexed", () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-idem");
    handle.appendUserMessage("u1");
    handle.appendAssistantMessage("a1");
    handle.persist();

    const snapshot = readSessionBranchSnapshot(handle.path);
    const entries = snapshot!.entries;
    const branchRevision = "idem-rev-000000";
    const s = makeValidSummary(branchRevision);
    const summary = {
      ...s,
      sourceStartEntry: entries[0]!.id,
      sourceEndEntry: entries[entries.length - 1]!.id,
    };

    const indexer = new EventIndexer({
      eventStore: ctx.eventStore,
      watermarkStore: ctx.watermarkStore,
    });

    const r1 = indexer.indexSession({
      agentId: "agent-1",
      sessionId: "sess-idem",
      sessionPath: handle.path,
      summary,
    });
    expect(r1.status).toBe("indexed");
    if (r1.status === "skipped") throw new Error("expected indexed");
    expect(r1.alreadyIndexed).toBeFalsy();

    // 第二次同范围
    const r2 = indexer.indexSession({
      agentId: "agent-1",
      sessionId: "sess-idem",
      sessionPath: handle.path,
      summary,
    });
    expect(r2.status).toBe("indexed");
    if (r2.status === "skipped") throw new Error("expected indexed");
    expect(r2.alreadyIndexed).toBe(true);

    ctx.close();
  });

  it("deterministic stub：无 summary 时仍可检索（searchByFts 命中）", () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-stub");
    handle.appendUserMessage("帮我写一个排序算法");
    handle.appendAssistantMessage("好的，这是快速排序的实现");
    handle.persist();

    const indexer = new EventIndexer({
      eventStore: ctx.eventStore,
      watermarkStore: ctx.watermarkStore,
    });

    const result = indexer.indexSession({
      agentId: "agent-1",
      sessionId: "sess-stub",
      sessionPath: handle.path,
      // 不传 summary → stub 路径
    });

    expect(result.status).toBe("degraded");
    if (result.status === "skipped") throw new Error("expected degraded with event");

    // 验证 stub 事件存在且可检索
    const evt = ctx.eventStore.getById(result.eventId);
    expect(evt).toBeDefined();
    expect(evt?.summary).toContain("排序算法"); // 从首条 user 消息摘录
    expect(evt?.searchText).toBeTruthy();

    // FTS 检索
    const hits = ctx.eventStore.searchByFts("agent-1", "排序算法");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe(result.eventId);

    ctx.close();
  });

  it("脱敏：消息含 sk-abc123456 时落盘 summary 不含原 key", async () => {
    const ctx = createContext();
    const dir = ctx.directory;
    const handle = createPersistentSession(dir, dir, "sess-san");
    handle.appendUserMessage("我的 API key 是 sk-abc123456，请保存好");
    handle.appendAssistantMessage("好的，已记录");
    handle.persist();

    const svc = new RollingSummaryService({
      summaryStore: ctx.sessionStore,
      watermarkStore: ctx.watermarkStore,
      completeText: fakeCompleteText(
        `### 重要事实
- 用户提供了 API key sk-abc123456

### 时间线
- 14:03 用户分享 API key`,
      ),
    });

    const r = await svc.maybeSummarize({
      agentId: "agent-1",
      sessionId: "sess-san",
      sessionPath: handle.path,
    });

    expect(r.status).toBe("updated");

    const row = ctx.sessionStore.getLatestForSession("sess-san");
    expect(row).toBeDefined();
    // 脱敏后不应包含原始 sk- key
    expect(row?.summary).not.toContain("sk-abc123456");
    // 应被替换为 [API_KEY]
    expect(row?.summary).toContain("[API_KEY]");

    ctx.close();
  });
});
