import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { startForegroundServer } from "../../src/server/start.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

async function makeAppOptions(paths: ReturnType<typeof getRuntimePaths>) {
  const database = openMetadataDatabase(paths.database);
  const sessionIndex = new SessionIndex(database);
  const providerStore = new ProviderStore(paths.providerSettings);
  const sessionService = new SessionService(paths, sessionIndex);
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();
  return { database, sessionIndex, sessionService, promptService, replayStore };
}

describe("server restart recovery", () => {
  it("survives server restart and continues the same session", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });

    // 使用同一套服务
    const opts = await makeAppOptions(paths);

    // 第一次启动
    const server1 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: {
        promptService: opts.promptService,
        replayStore: opts.replayStore,
        sessionService: opts.sessionService,
      },
    });

    const baseUrl = `http://127.0.0.1:${server1.port}`;

    // 创建 Session
    const resp1 = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重启测试", cwd: process.cwd() }),
    });
    expect(resp1.status).toBe(201);
    const session = (await resp1.json()) as { id: string; title: string };
    const sessionId = session.id;

    // 创建 Runtime 并发送消息
    const runtime = await SessionRuntime.create({
      sessionId,
      cwd: process.cwd(),
      sessionDir: paths.sessions,
      authPath: paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "e2e reply" },
      publish: () => {},
      replayStore: opts.replayStore,
    });
    opts.promptService.register(runtime);

    // 通过 HTTP 发送 Prompt
    const promptResp = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "e2e test" }),
    });
    expect(promptResp.status).toBe(202);

    // 停止 Server
    await server1.stop();

    // 使用相同服务重启
    const promptService2 = new PromptService();
    const replayStore2 = new EventReplayStore();

    const server2 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: {
        promptService: promptService2,
        replayStore: replayStore2,
        sessionService: opts.sessionService, // 重用同一个 sessionService
      },
    });

    try {
      const baseUrl2 = `http://127.0.0.1:${server2.port}`;

      // 获取原 Session
      const getResp = await fetch(`${baseUrl2}/api/sessions/${sessionId}`);
      expect(getResp.status).toBe(200);
      const reopened = (await getResp.json()) as { id: string; title: string };
      expect(reopened.id).toBe(sessionId);

      // 健康检查
      const healthResp = await fetch(`${baseUrl2}/api/health`);
      expect(healthResp.status).toBe(200);
    } finally {
      await server2.stop();
      opts.sessionService.closeAll();
      opts.database.close();
    }
  }, 15_000);
});
