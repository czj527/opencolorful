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
import { getLeafEntryId } from "../../src/pi-sdk/index.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

// ═══════════════════════════════════════════════════════════════
// P1 波次B B2：会话分支 API 集成测试（regenerate / 分支切换 / 树与条目视图 / 视图扩展）。
// 全部使用 faux provider + 临时 OPENCOLORFUL_HOME + 真实 SQLite/JSONL，
// 不请求真实 Provider 网络。Fork 场景见 session-fork.test.ts。
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-branch-api-"));
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

/** 为会话创建 faux runtime（走与生产一致的 sessionHandle 绑定路径）。 */
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
    faux: { response },
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

/** 读取 JSONL 中的全部条目 id（含跨分支，文件序）。 */
function jsonlEntryIds(sessionFile: string): string[] {
  return fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(1) // 去掉 session header
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

function postJson(context: TestContext, url: string, body: unknown) {
  return context.app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitIdle(context: TestContext, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!context.promptService.isBusy(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`会话 ${sessionId} 未在限时内回到空闲`);
}

describe("会话分支 API（B2）", () => {
  it("regenerate happy path：原分支保留 + 新兄弟分支 + 树双分支 + 分支头更新 + JSONL append-only", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "重生成会话", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id);
      await runtime.prompt("第一版提问").completed;

      const entriesBefore = context.service.getEntries(created.id);
      const firstUserEntry = entriesBefore.entries.find((entry) => entry.role === "user")!;
      expect(firstUserEntry.turnId).toBe(`turn-${firstUserEntry.entryId}`);

      const sessionFile = created.path;
      const bytesBefore = fs.readFileSync(sessionFile, "utf8");

      const response = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: firstUserEntry.entryId,
        text: "第一版提问（重试）",
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        status: string;
        sessionId: string;
        streamId: string;
        branchId: string;
      };
      expect(body.status).toBe("accepted");
      expect(body.sessionId).toBe(created.id);
      expect(body.streamId).toMatch(/^stream-/);
      await waitIdle(context, created.id);

      // 新用户条目 = branchId，携带新文本
      const newEntries = context.service.getEntries(created.id);
      const newUserEntry = newEntries.entries.find((entry) => entry.entryId === body.branchId);
      expect(newUserEntry).toBeDefined();
      expect(newUserEntry!.text).toBe("第一版提问（重试）");
      expect(newUserEntry!.role).toBe("user");
      expect(newUserEntry!.turnId).toBe(`turn-${body.branchId}`);

      // JSONL append-only：原字节是前缀；原分支与新分支条目都在文件中
      const bytesAfter = fs.readFileSync(sessionFile, "utf8");
      expect(bytesAfter.startsWith(bytesBefore)).toBe(true);
      const ids = jsonlEntryIds(sessionFile);
      expect(ids).toContain(firstUserEntry.entryId);
      expect(ids).toContain(body.branchId);

      // 树：两片叶子（旧分支叶子 + 新分支叶子），仅新分支 isCurrent
      const tree = context.service.getTree(created.id);
      expect(tree.branches).toHaveLength(2);
      expect(tree.currentBranchId).not.toBeNull();
      expect(tree.branches.filter((branch) => branch.isCurrent)).toHaveLength(1);
      expect(tree.branches.find((branch) => branch.isCurrent)!.branchId).toBe(tree.currentBranchId);
      // 分支头已刷新（= 当前叶子）
      expect(context.index.get(created.id)?.branchHeadEntryId).toBe(tree.currentBranchId);
    } finally {
      disposeContext(context);
    }
  });

  it("regenerate negatives：assistant 目标解析到用户条目、未知目标 404、空文本 400", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "重生成负例", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id);
      await runtime.prompt("你好").completed;

      const entries = context.service.getEntries(created.id).entries;
      const userEntry = entries.find((entry) => entry.role === "user")!;
      const assistantEntry = entries.find((entry) => entry.role === "assistant")!;

      // assistant 目标 → 解析到该 turn 的 user entry，成功（重试语义）
      const viaAssistant = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: assistantEntry.entryId,
        text: "重试提问",
      });
      expect(viaAssistant.status).toBe(202);
      await waitIdle(context, created.id);

      // 未知目标 → 404 NOT_FOUND
      const missing = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: "00000000",
        text: "任何文本",
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: string }).code).toBe("NOT_FOUND");

      // 空文本 → 400 INVALID_INPUT
      const empty = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: userEntry.entryId,
        text: "   ",
      });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { code: string }).code).toBe("INVALID_INPUT");
    } finally {
      disposeContext(context);
    }
  });

  it("regenerate 目标无用户祖先 → 400（根级孤立 assistant 条目）", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "无用户祖先", cwd: process.cwd() });
      await attachRuntime(context, created.id);
      // 直接经受控适配器构造一条没有用户祖先的根级 assistant 条目
      const session = context.service.open(created.id);
      const { branchToRoot } = await import("../../src/pi-sdk/index.js");
      branchToRoot(session);
      session.appendAssistantMessage("孤立回答");
      session.persist();
      const orphan = context.service.getEntries(created.id).entries.find((entry) => entry.role === "assistant")!;

      const response = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: orphan.entryId,
        text: "尝试重生成",
      });
      expect(response.status).toBe(400);
      const error = (await response.json()) as { code: string; message: string };
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("用户消息");
    } finally {
      disposeContext(context);
    }
  });

  it("regenerate 与进行中 turn 并发 → 409 SESSION_BUSY", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "并发重生成", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id, "abcdefghijklmnopqrstuvwxyz");
      await runtime.prompt("首次").completed;

      const entries = context.service.getEntries(created.id).entries;
      const userEntry = entries.find((entry) => entry.role === "user")!;

      // 启动一个慢 turn，在其进行中发起 regenerate
      const slow = runtime.prompt("进行中的慢请求");
      expect(context.promptService.isBusy(created.id)).toBe(true);

      const response = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: userEntry.entryId,
        text: "并发重试",
      });
      expect(response.status).toBe(409);
      const error = (await response.json()) as { code: string; message: string };
      expect(error.code).toBe("SESSION_BUSY");
      expect(error.message).toBe("会话正在运行，请先停止后再操作");

      runtime.abort(slow.streamId);
      await slow.completed;
    } finally {
      disposeContext(context);
    }
  });

  it("branch switch：head 持久化、重开应用 head、append 后 head 让位、404、Replay 事件", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "分支切换", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id);
      await runtime.prompt("第一轮").completed;

      // 构造两条分支：从第一轮的用户条目 regenerate 出兄弟分支
      const firstUser = context.service.getEntries(created.id).entries.find((entry) => entry.role === "user")!;
      const regenerated = await postJson(context, `/api/sessions/${created.id}/regenerate`, {
        targetEntryId: firstUser.entryId,
        text: "重试分支",
      });
      expect(regenerated.status).toBe(202);
      const { branchId: newBranchId } = (await regenerated.json()) as { branchId: string };
      await waitIdle(context, created.id);

      const tree = context.service.getTree(created.id);
      expect(tree.branches).toHaveLength(2);
      const oldBranch = tree.branches.find((branch) => branch.branchId !== newBranchId)!;

      // 切回旧分支
      const switched = await postJson(context, `/api/sessions/${created.id}/branch/switch`, {
        branchId: oldBranch.branchId,
      });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toEqual({
        branchId: oldBranch.branchId,
        currentBranchId: oldBranch.branchId,
      });
      expect(context.index.get(created.id)?.branchHeadEntryId).toBe(oldBranch.branchId);

      // Replay Store 可观察 session.branch.switched + session.branches.changed{switch}
      const branchEvents = context.replayStore
        .listSessionStreams(created.id)
        .flatMap((streamId) => context.replayStore.getSince(streamId, 0).events)
        .filter(
          (event) =>
            event.type === "session.branch.switched" || event.type === "session.branches.changed",
        );
      const switchedEvent = branchEvents.find((event) => event.type === "session.branch.switched");
      expect(switchedEvent?.payload).toMatchObject({ branchId: oldBranch.branchId });
      // 独立 branch 流上 sequence 从 1 严格开始（Replay Store 先写再广播）
      expect(switchedEvent?.streamId).toMatch(/^branch-/);
      expect(switchedEvent?.sequence).toBe(1);
      const changedEvent = branchEvents
        .filter((event) => event.type === "session.branches.changed")
        .find((event) => (event.payload as { reason?: string }).reason === "switch");
      expect(changedEvent?.payload).toMatchObject({ reason: "switch" });

      // 关闭 runtime 与会话句柄后重开：文件序最后 entry（重生成分支叶子）不是
      // head 的后代 → 应用 head，当前分支回到旧分支
      context.promptService.invalidate(created.id);
      context.service.closeAll();
      const reopened = context.service.open(created.id);
      expect(getLeafEntryId(reopened)).toBe(oldBranch.branchId);

      // 在旧分支上 prompt（append）→ 新叶子是 head 的后代 → 文件序最后 entry 胜出
      context.promptService.register(
        await SessionRuntime.create({
          sessionId: created.id,
          cwd: process.cwd(),
          sessionDir: context.paths.sessions,
          authPath: context.paths.authFile,
          providerId: "faux",
          modelId: "faux-1",
          faux: { response: "旧分支续聊" },
          publish: () => {},
          replayStore: context.replayStore,
          sessionHandle: reopened,
        }),
      );
      await context.promptService.prompt(created.id, "旧分支续聊").completed;
      const afterAppend = context.index.get(created.id);
      expect(afterAppend?.branchHeadEntryId).not.toBe(oldBranch.branchId);
      context.promptService.invalidate(created.id);
      context.service.closeAll();
      const reopenedAgain = context.service.open(created.id);
      expect(getLeafEntryId(reopenedAgain)).not.toBe(oldBranch.branchId);

      // 未知分支 → 404（走 ensureRuntime 懒创建路径）
      const unknown = await postJson(context, `/api/sessions/${created.id}/branch/switch`, {
        branchId: "ffffffff",
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { code: string }).code).toBe("NOT_FOUND");
    } finally {
      disposeContext(context);
    }
  });

  it("tree/entries 端点形状 + turnId 分组 + 空会话形状", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "视图会话", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id);
      await runtime.prompt("第一问").completed;
      await runtime.prompt("第二问").completed;

      const treeResponse = await context.app.request(`/api/sessions/${created.id}/tree`);
      expect(treeResponse.status).toBe(200);
      const tree = (await treeResponse.json()) as {
        currentBranchId: string | null;
        branches: {
          branchId: string;
          leafEntryId: string;
          leafPreview: string;
          entryCount: number;
          updatedAt: string;
          isCurrent: boolean;
        }[];
      };
      expect(tree.branches).toHaveLength(1);
      expect(tree.branches[0]!.isCurrent).toBe(true);
      expect(tree.branches[0]!.branchId).toBe(tree.currentBranchId);
      expect(tree.branches[0]!.leafEntryId).toBe(tree.currentBranchId);
      expect(tree.branches[0]!.leafPreview.length).toBeLessThanOrEqual(81); // 80 字符 + 省略号
      expect(tree.branches[0]!.entryCount).toBeGreaterThan(0);
      expect(tree.branches[0]!.updatedAt).toBeTypeOf("string");

      const entriesResponse = await context.app.request(`/api/sessions/${created.id}/entries`);
      expect(entriesResponse.status).toBe(200);
      const entriesView = (await entriesResponse.json()) as {
        branchId: string | null;
        currentBranchId: string | null;
        entries: {
          entryId: string;
          parentId: string | null;
          turnId: string | null;
          type: string;
          role?: string;
          text: string;
          timestamp: string;
        }[];
      };
      expect(entriesView.branchId).toBe(tree.currentBranchId);
      expect(entriesView.currentBranchId).toBe(tree.currentBranchId);

      // turnId 分组：user 条目开启 turn，其后 assistant 条目继承同 turn
      const users = entriesView.entries.filter((entry) => entry.role === "user");
      expect(users).toHaveLength(2);
      const firstTurnId = users[0]!.turnId;
      expect(firstTurnId).toBe(`turn-${users[0]!.entryId}`);
      const assistantOfFirstTurn = entriesView.entries.find(
        (entry) => entry.role === "assistant" && entry.parentId === users[0]!.entryId,
      );
      expect(assistantOfFirstTurn?.turnId).toBe(firstTurnId);
      expect(users[1]!.turnId).not.toBe(firstTurnId);

      // 指定未知 branchId → 404
      const unknown = await context.app.request(`/api/sessions/${created.id}/entries?branchId=ffffffff`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { code: string }).code).toBe("NOT_FOUND");

      // 空会话（仅 session_info 标题条目，无任何消息）：branches 空、currentBranchId null
      const empty = context.service.create({ title: "空会话", cwd: process.cwd() });
      const emptyTree = await context.app.request(`/api/sessions/${empty.id}/tree`);
      expect(await emptyTree.json()).toEqual({ currentBranchId: null, branches: [] });
      const emptyEntries = await context.app.request(`/api/sessions/${empty.id}/entries`);
      expect(await emptyEntries.json()).toEqual({ branchId: null, currentBranchId: null, entries: [] });
    } finally {
      disposeContext(context);
    }
  });

  it("SessionView 新增 currentBranchId/sourceSessionId/entries，messageEntries 兼容不变", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "视图扩展会话", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id);
      await runtime.prompt("消息一").completed;

      const response = await context.app.request(`/api/sessions/${created.id}`);
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        currentBranchId: string | null;
        sourceSessionId: string | null;
        branchHeadEntryId: string | null;
        entries: { entryId: string; turnId: string | null }[];
        messageEntries: { role: string; content: string }[];
      };
      expect(view.sourceSessionId).toBeNull();
      expect(view.branchHeadEntryId).toBeTypeOf("string");
      expect(view.currentBranchId).toBeTypeOf("string");
      expect(view.entries.length).toBeGreaterThan(0);
      expect(view.entries.every((entry) => typeof entry.entryId === "string")).toBe(true);
      // messageEntries 兼容（拍平、无 id）
      expect(view.messageEntries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(view.messageEntries[0]!.content).toBe("消息一");
    } finally {
      disposeContext(context);
    }
  });

  it("读取路径一致性：turn 进行中 getEntries 走活跃句柄（无半写读取）", async () => {
    const context = createContext();
    try {
      const created = context.service.create({ title: "读一致性", cwd: process.cwd() });
      const runtime = await attachRuntime(context, created.id, "abcdefghijklmnopqrstuvwxyz");
      // 先落一轮对话（排除新建会话仅含标题条目的空态）
      await runtime.prompt("预热一轮").completed;
      const run = runtime.prompt("实时消息");
      const mid = context.service.getEntries(created.id);
      expect(mid.currentBranchId).toBeTypeOf("string");
      expect(mid.entries.some((entry) => entry.role === "user")).toBe(true);
      await run.completed;
      const after = context.service.getEntries(created.id);
      expect(after.entries.some((entry) => entry.role === "assistant")).toBe(true);
    } finally {
      disposeContext(context);
    }
  });
});
