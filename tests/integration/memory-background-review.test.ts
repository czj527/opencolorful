import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { BackgroundReviewService } from "../../src/runtime/memory/background-review.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { PinnedMemoryStore } from "../../src/storage/memory/pinned-store.js";

const contexts: Array<{ dir: string; close: () => void }> = [];

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.close();
    fs.rmSync(context.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function makeContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-review-"));
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  contexts.push({ dir, close: () => database.close() });
  return { dir, paths, database };
}

function event(sessionId: string, sequence: number): PlatformEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-${sequence}`,
    sessionId,
    streamId: `stream-${sessionId}`,
    sequence,
    timestamp: new Date().toISOString(),
    type: "turn.completed",
    payload: { turnId: `turn-${sequence}` },
  };
}

/** 写一个最小可读会话（header + 一轮对答） */
function writeSession(dir: string, sessionId: string): string {
  const sessionPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "以后回复我都用项目符号列表" } }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "好的，记住了。" }] } }),
  ].join("\n") + "\n");
  return sessionPath;
}

function makeView(sessionId: string, sessionPath: string, agentId: string | null) {
  return {
    id: sessionId, title: "测试", sessionPath,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", archived: false,
    agentId, toolMode: "off", workspaceCwd: null, workspaceConfirmed: false,
    messages: [], messageEntries: [], model: null,
  };
}

interface SetupOptions {
  readonly reviewEnabled?: boolean;
  readonly enabled?: boolean;
  readonly agentId?: string | null;
  readonly llm: (agentId: string, req: { systemPrompt: string; prompt: string; maxTokens?: number }) => Promise<string>;
}

function setup(options: SetupOptions) {
  const { paths, database } = makeContext();
  const replayStore = new EventReplayStore();
  const journalStore = new MemoryJournalStore(database);
  const sessionPath = writeSession(paths.home, "s1");
  const agentId = options.agentId === undefined ? "a1" : options.agentId;
  const view = makeView("s1", sessionPath, agentId);
  const completeText = vi.fn(options.llm);
  const service = new BackgroundReviewService({
    replayStore,
    sessionService: { getView: vi.fn(() => view) } as never,
    journalStore,
    pinnedStore: new PinnedMemoryStore(database),
    agentsDir: path.join(paths.home, "agents"),
    sessionPathResolver: () => sessionPath,
    completeText,
    settingsResolver: () => ({
      enabled: options.enabled ?? true,
      reviewEnabled: options.reviewEnabled ?? true,
    }),
  });
  return { replayStore, journalStore, service, completeText, agentId };
}

describe("BackgroundReviewService（切片 1.75 T14）", () => {
  it("turn.completed 后复盘产出 intent：journal 追加 actor=background_review 的 pending 记录", async () => {
    const { replayStore, journalStore, service, completeText } = setup({
      llm: async () => JSON.stringify({ intents: [{ fact: "用户偏好项目符号列表格式的回复", tags: ["偏好"], priority: 4 }] }),
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();

    expect(completeText).toHaveBeenCalledTimes(1);
    const pending = journalStore.listPending("a1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.actor).toBe("background_review");
    expect(pending[0]!.intentType).toBe("remember");
    expect(pending[0]!.payload["fact"]).toBe("用户偏好项目符号列表格式的回复");
    expect(pending[0]!.priority).toBe(4);
    service.stop();
  });

  it("复盘输出空 intents：合法“没什么可记”，不写 journal", async () => {
    const { replayStore, journalStore, service, completeText } = setup({
      llm: async () => "{\"intents\":[]}",
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(journalStore.listPending("a1")).toHaveLength(0);
    service.stop();
  });

  it("reviewEnabled=false：完全不调用 LLM", async () => {
    const { replayStore, journalStore, service, completeText } = setup({
      reviewEnabled: false,
      llm: async () => "{\"intents\":[]}",
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();

    expect(completeText).not.toHaveBeenCalled();
    expect(journalStore.listPending("a1")).toHaveLength(0);
    service.stop();
  });

  it("记忆整理总开关 enabled=false：复盘同样关闭", async () => {
    const { replayStore, service, completeText } = setup({
      enabled: false,
      llm: async () => "{\"intents\":[]}",
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();

    expect(completeText).not.toHaveBeenCalled();
    service.stop();
  });

  it("LLM 不可用：降级静默，不写 journal，不影响后续轮次", async () => {
    const { replayStore, journalStore, service } = setup({
      llm: async () => { throw new Error("无可用 Provider 凭据"); },
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();
    expect(journalStore.listPending("a1")).toHaveLength(0);
    service.stop();
  });

  it("LLM 输出非 JSON：降级，不写 journal", async () => {
    const { replayStore, journalStore, service } = setup({
      llm: async () => "我觉得这轮没什么好记的。",
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();
    expect(journalStore.listPending("a1")).toHaveLength(0);
    service.stop();
  });

  it("未绑定助理的会话（agentId=null）：直接跳过", async () => {
    const { replayStore, service, completeText } = setup({
      agentId: null,
      llm: async () => "{\"intents\":[]}",
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();
    expect(completeText).not.toHaveBeenCalled();
    service.stop();
  });

  it("防御式解析：fact 缺字段/空串的条目被丢弃，其余正常写入", async () => {
    const { replayStore, journalStore, service } = setup({
      llm: async () => JSON.stringify({ intents: [{ fact: "" }, { noFact: true }, { fact: "用户使用 Windows 开发环境" }] }),
    });
    replayStore.publish(event("s1", 1));
    await new Promise((resolve) => setImmediate(resolve));
    await service.flush();

    const pending = journalStore.listPending("a1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload["fact"]).toBe("用户使用 Windows 开发环境");
    service.stop();
  });
});
