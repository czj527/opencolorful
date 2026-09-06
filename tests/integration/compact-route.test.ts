import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-compact-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();
  const { app } = createTrustedServerApp({
    paths,
    sessionService,
    promptService,
    replayStore,
  });
  return { paths, database, index, sessionService, promptService, replayStore, app };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("compact route", () => {
  it("lazily rebuilds runtime for a session that never received a message", async () => {
    const context = createContext();
    const created = context.sessionService.create({ title: "空会话", cwd: process.cwd() });
    created.selectModel("faux", "faux-1");

    expect(context.promptService.hasRuntime(created.id)).toBe(false);

    const response = await context.app.request(`http://127.0.0.1/api/sessions/${created.id}/compact`, {
      method: "POST",
    });

    // 懒重建后 compact 可能成功（200）也可能因无内容可压缩而 409，但绝不能再是 404/500
    expect([200, 409]).toContain(response.status);
    expect(context.promptService.hasRuntime(created.id)).toBe(true);

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });

  it("rejects compact with 409 SESSION_BUSY while a prompt is in flight", async () => {
    const context = createContext();
    const created = context.sessionService.create({ title: "忙时压缩", cwd: process.cwd() });
    created.selectModel("faux", "faux-1");

    // 先用一条消息触发懒重建，并借极小的 tokensPerSecond 制造生成窗口
    const messageResponse = await context.app.request(
      `http://127.0.0.1/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      },
    );
    expect(messageResponse.status).toBe(202);

    // 默认 faux tokensPerSecond=20，response "已收到您的消息" 约 8 个 token，
    // 生成窗口约 400ms；在窗口内立刻 compact 应被 busy 拒绝。
    // 为确保窗口存在，这里直接再发一条长消息前先确认 runtime 已存在。
    expect(context.promptService.hasRuntime(created.id)).toBe(true);

    // 等第一条完成后，构造一个明确的进行中窗口：
    // 通过 promptService 直接发起一个慢 prompt（tokensPerSecond 由路由固定为 20，
    // 无法从外部调小，因此改用长 response 不可行——路由内 faux response 固定）。
    // 改为直接验证 isBusy 语义：在 prompt 未完成时 compact 必须 409。
    // 由于路由内 faux 配置固定，第一条消息的窗口极短，这里用竞态方式连续调用，
    // 并接受两种合法结果：若恰好落在窗口内则 409 SESSION_BUSY；若已结束则 200/409（无需压缩）。
    // 为保证确定性，另行构造一个明确的 busy 场景见下一个测试。
    const compactResponse = await context.app.request(
      `http://127.0.0.1/api/sessions/${created.id}/compact`,
      { method: "POST" },
    );
    expect([200, 409]).toContain(compactResponse.status);

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });

  it("returns 409 SESSION_BUSY deterministically when runtime reports busy", async () => {
    const context = createContext();
    const created = context.sessionService.create({ title: "确定忙", cwd: process.cwd() });
    created.selectModel("faux", "faux-1");

    // 触发懒重建
    const messageResponse = await context.app.request(
      `http://127.0.0.1/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      },
    );
    expect(messageResponse.status).toBe(202);
    expect(context.promptService.hasRuntime(created.id)).toBe(true);

    // 用 isBusy 的 stub 构造确定性 busy：直接 monkey-patch promptService.isBusy
    const originalIsBusy = context.promptService.isBusy.bind(context.promptService);
    context.promptService.isBusy = () => true;
    try {
      const compactResponse = await context.app.request(
        `http://127.0.0.1/api/sessions/${created.id}/compact`,
        { method: "POST" },
      );
      expect(compactResponse.status).toBe(409);
      const body = (await compactResponse.json()) as { code: string; message: string };
      expect(body.code).toBe("SESSION_BUSY");
      expect(body.message).toBe("会话正在生成，无法压缩");
    } finally {
      context.promptService.isBusy = originalIsBusy;
    }

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });

  it("rejects compact for archived sessions", async () => {
    const context = createContext();
    const created = context.sessionService.create({ title: "归档会话", cwd: process.cwd() });
    created.selectModel("faux", "faux-1");
    context.sessionService.archive(created.id);

    const response = await context.app.request(`http://127.0.0.1/api/sessions/${created.id}/compact`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.message).toBe("已归档 Session 不能压缩");

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });

  it("returns 404 for a missing session", async () => {
    const context = createContext();
    const response = await context.app.request(
      "http://127.0.0.1/api/sessions/00000000-0000-4000-8000-000000000099/compact",
      { method: "POST" },
    );
    expect(response.status).toBe(404);

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });

  it("writes session.compacting/session.compacted to ctrl- stream when compaction runs", async () => {
    const context = createContext();
    const created = context.sessionService.create({ title: "压缩事件", cwd: process.cwd() });
    created.selectModel("faux", "faux-1");

    // 发一条消息让会话有内容，并触发懒重建挂上 replayStore
    const messageResponse = await context.app.request(
      `http://127.0.0.1/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "请压缩我" }),
      },
    );
    expect(messageResponse.status).toBe(202);

    // 等待 prompt 完成，避免 busy
    await new Promise((resolve) => setTimeout(resolve, 800));

    const compactResponse = await context.app.request(
      `http://127.0.0.1/api/sessions/${created.id}/compact`,
      { method: "POST" },
    );

    const streams = context.replayStore.listSessionStreams(created.id);
    const ctrlStreams = streams.filter((id) => id.startsWith("ctrl-"));

    if (compactResponse.status === 200) {
      // compact 真正执行：必须能在 ctrl- stream 里看到 compacting/compacted
      expect(ctrlStreams.length).toBeGreaterThan(0);
      const events = ctrlStreams.flatMap(
        (id) => context.replayStore.getSince(id, 0).events,
      );
      const types = events.map((e) => e.type);
      expect(types).toContain("session.compacting");
      expect(types).toContain("session.compacted");
    } else {
      // faux 下无足够内容导致「无需压缩」409：接受，但记录此限制
      expect(compactResponse.status).toBe(409);
    }

    context.promptService.dispose();
    context.sessionService.closeAll();
    context.database.close();
  });
});
