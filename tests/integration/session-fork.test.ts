import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { createServerApp } from "../../src/server/app.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

// ═══════════════════════════════════════════════════════════════
// P1 波次B B2：Fork 成独立会话（plans/p1-conversation-workbench.en.md §3.2.2）。
// 分离 SessionManager 实例 → 源文件/源 runtime 不受影响；新 SQLite 行携带
// source_session_id/source_leaf_entry_id； faux provider + 临时隔离目录。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

interface TestContext {
  readonly paths: ReturnType<typeof getRuntimePaths>;
  readonly database: ReturnType<typeof openMetadataDatabase>;
  readonly index: SessionIndex;
  readonly service: SessionService;
  readonly promptService: PromptService;
  readonly replayStore: EventReplayStore;
  readonly app: ReturnType<typeof createServerApp>["app"];
  readonly runtimes: SessionRuntime[];
}

function createContext(): TestContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-fork-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const service = new SessionService(paths, index);
  const replayStore = new EventReplayStore();
  const promptService = new PromptService();
  const { app } = createTrustedServerApp({
    paths,
    sessionService: service,
    promptService,
    replayStore,
    database,
  });
  return { paths, database, index, service, promptService, replayStore, app, runtimes: [] };
}

async function attachRuntime(
  context: TestContext,
  sessionId: string,
  response = "faux 回复",
): Promise<SessionRuntime> {
  const session = context.service.open(sessionId);
  const runtime = await SessionRuntime.create({
    sessionId,
    cwd: process.cwd(),
    sessionDir: context.paths.sessions,
    authPath: context.paths.authFile,
    providerId: "faux",
    modelId: "faux-1",
    faux: { response: "faux 回复" },
    publish: () => {},
    replayStore: context.replayStore,
    sessionHandle: session,
  });
  context.promptService.register(runtime);
  context.runtimes.push(runtime);
  return runtime;
}

function disposeContext(context: TestContext): void {
  for (const runtime of context.runtimes) runtime.dispose();
  context.promptService.dispose();
  context.service.closeAll();
  context.database.close();
}

function postJson(context: TestContext, url: string, body: unknown) {
  return context.app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Fork 成独立会话（B2）", () => {
  it("happy path：201 视图带溯源元数据、新 JSONL 带 parentSession 头、源文件字节不变", async () => {
    const context = createContext();
    try {
      const source = context.service.create({ title: "源会话", cwd: process.cwd() });
      source.appendUserMessage("源提问");
      source.appendAssistantMessage("源回答");
      source.persist();
      const sourcePath = source.path;
      const sourceBytes = fs.readFileSync(sourcePath, "utf8");

      const response = await postJson(context, `/api/sessions/${source.id}/fork`, {});
      expect(response.status).toBe(201);
      const view = (await response.json()) as {
        id: string;
        title: string;
        sourceSessionId: string | null;
        sourceLeafEntryId: string | null;
        sessionPath: string;
        currentBranchId: string | null;
        entries: { role?: string; text: string }[];
        messageEntries: { role: string; content: string }[];
      };
      expect(view.id).not.toBe(source.id);
      expect(view.sourceSessionId).toBe(source.id);
      expect(view.sourceLeafEntryId).not.toBeNull();
      expect(view.title).toBe("源会话（Fork）");
      // 新 JSONL 存在且与源文件不同
      expect(view.sessionPath).not.toBe(sourcePath);
      expect(fs.existsSync(view.sessionPath)).toBe(true);

      // 新会话视图：完整条目（fork 点前的消息全部带过来）
      expect(view.entries.some((entry) => entry.text === "源提问")).toBe(true);
      expect(view.messageEntries.map((entry) => entry.content)).toEqual(["源提问", "源回答"]);

      // 源文件字节不变（分离实例，源不受影响）
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);

      // 新文件 header 指向源文件（PI parentSession 头）
      const headerLine = fs.readFileSync(view.sessionPath, "utf8").split("\n")[0]!;
      const header = JSON.parse(headerLine) as { type: string; id: string; parentSession?: string };
      expect(header.type).toBe("session");
      expect(header.id).toBe(view.id);
      expect(header.parentSession).toBe(path.resolve(sourcePath));

      // 索引行：source 元数据 + 继承 agentId（无 Agent → null）
      const metadata = context.index.get(view.id);
      expect(metadata?.sourceSessionId).toBe(source.id);
      expect(metadata?.sourceLeafEntryId).toBe(view.sourceLeafEntryId);
      expect(metadata?.agentId).toBeNull();
    } finally {
      disposeContext(context);
    }
  });

  it("Fork 后源会话仍可继续对话；新会话独立可用", async () => {
    const context = createContext();
    try {
      const source = context.service.create({ title: "活源", cwd: process.cwd() });
      source.appendUserMessage("源问");
      source.appendAssistantMessage("源答");
      source.persist();

      const forkResponse = await postJson(context, `/api/sessions/${source.id}/fork`, {});
      expect(forkResponse.status).toBe(201);
      const forkView = (await forkResponse.json()) as { id: string };

      // 源会话仍可对话（runtime 正常收发）
      const sourceRuntime = await attachRuntime(context, source.id);
      await sourceRuntime.prompt("源会话后续消息").completed;
      expect(context.service.getView(source.id).messageEntries.map((e) => e.content)).toEqual([
        "源问",
        "源答",
        "源会话后续消息",
        "faux 回复",
      ]);

      // 新会话独立：重新打开可继续
      const forkRuntime = await SessionRuntime.create({
        sessionId: forkView.id,
        cwd: process.cwd(),
        sessionDir: context.paths.sessions,
        authPath: context.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "fork 回复" },
        publish: () => {},
        replayStore: context.replayStore,
        sessionHandle: context.service.open(forkView.id),
      });
      context.runtimes.push(forkRuntime);
      await forkRuntime.prompt("fork 续聊").completed;
      const forkMessages = context.service.getView(forkView.id).messageEntries.map((e) => e.content);
      expect(forkMessages).toEqual(["源问", "源答", "fork 续聊", "fork 回复"]);
    } finally {
      disposeContext(context);
    }
  });

  it("指定 targetEntryId：新会话只含目标路径；未知目标 404", async () => {
    const context = createContext();
    try {
      const source = context.service.create({ title: "定点 Fork", cwd: process.cwd() });
      source.appendUserMessage("第一问");
      source.appendAssistantMessage("第一答");
      source.appendUserMessage("第二问");
      source.appendAssistantMessage("第二答");
      source.persist();
      const firstUser = context.service
        .getEntries(source.id)
        .entries.find((entry) => entry.role === "user" && entry.text === "第一问")!;

      const response = await postJson(context, `/api/sessions/${source.id}/fork`, {
        targetEntryId: firstUser.entryId,
      });
      expect(response.status).toBe(201);
      const view = (await response.json()) as {
        sourceLeafEntryId: string | null;
        entries: { text: string }[];
      };
      expect(view.sourceLeafEntryId).toBe(firstUser.entryId);
      // 只含根→目标路径（根为 session_info 标题条目，正文为空）
      expect(view.entries.map((entry) => entry.text)).toEqual(["", "第一问"]);

      // 未知目标 → 404
      const missing = await postJson(context, `/api/sessions/${source.id}/fork`, {
        targetEntryId: "ffffffff",
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: string }).code).toBe("NOT_FOUND");
    } finally {
      disposeContext(context);
    }
  });

  it("空会话（无消息条目）Fork → 400 空会话无法 Fork", async () => {
    const context = createContext();
    try {
      const empty = context.service.create({ title: "空会话", cwd: process.cwd() });
      const response = await postJson(context, `/api/sessions/${empty.id}/fork`, {});
      expect(response.status).toBe(400);
      const error = (await response.json()) as { code: string; message: string };
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe("空会话无法 Fork");
    } finally {
      disposeContext(context);
    }
  });

  it("Fork 与进行中 turn 并发 → 409 SESSION_BUSY；归档会话 → 409 CONFLICT", async () => {
    const context = createContext();
    try {
      const source = context.service.create({ title: "忙源", cwd: process.cwd() });
      source.appendUserMessage("问");
      source.appendAssistantMessage("答");
      source.persist();

      // 归档 → 409（先验证归档路径，随后恢复）
      const archived = context.service.archive(source.id);
      expect(archived.archived).toBe(true);
      const archiveResponse = await postJson(context, `/api/sessions/${source.id}/fork`, {});
      expect(archiveResponse.status).toBe(409);
      expect(((await archiveResponse.json()) as { code: string }).code).toBe("CONFLICT");
      context.service.unarchive(source.id);

      // 忙 → 409
      const runtime = await attachRuntime(context, source.id, "abcdefghijklmnopqrstuvwxyz");
      const slow = runtime.prompt("进行中");
      expect(context.promptService.isBusy(source.id)).toBe(true);
      const busyResponse = await postJson(context, `/api/sessions/${source.id}/fork`, {});
      expect(busyResponse.status).toBe(409);
      expect(((await busyResponse.json()) as { code: string }).code).toBe("SESSION_BUSY");
      runtime.abort(slow.streamId);
      await slow.completed;
    } finally {
      disposeContext(context);
    }
  });

  it("Fork 成功后在源会话流上广播 branches.changed{fork}（runtime 已加载时）", async () => {
    const context = createContext();
    try {
      const source = context.service.create({ title: "事件源", cwd: process.cwd() });
      source.appendUserMessage("问");
      source.appendAssistantMessage("答");
      source.persist();
      // 加载 runtime（fork 事件只对已加载源会话流可达）
      await attachRuntime(context, source.id);

      const response = await postJson(context, `/api/sessions/${source.id}/fork`, {});
      expect(response.status).toBe(201);

      // EventReplayStore 订阅是异步通知；fork 事件在响应前同步发布
      const forkEvents = context.replayStore
        .listSessionStreams(source.id)
        .flatMap((streamId) => context.replayStore.getSince(streamId, 0).events)
        .filter((event) => event.type === "session.branches.changed");
      expect(forkEvents.some((event) => (event.payload as { reason?: string }).reason === "fork")).toBe(true);
    } finally {
      disposeContext(context);
    }
  });
});
