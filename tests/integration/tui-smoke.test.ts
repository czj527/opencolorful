import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { startForegroundServer } from "../../src/server/start.js";
import { TuiApiClient } from "../../src/tui/api-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("TUI smoke test", () => {
  it("interacts with server API end to end via TuiApiClient", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-tui-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
    const replayStore = new EventReplayStore();
    const promptService = new PromptService();
    const database = openMetadataDatabase(paths.database);
    const sessionIndex = new SessionIndex(database);
    const sessionService = new SessionService(paths, sessionIndex);

    const server = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: { promptService, replayStore, sessionService },
    });

    try {
      const api = new TuiApiClient(`http://127.0.0.1:${server.port}`);

      // 健康检查
      const health = await api.getHealth();
      expect(health.status).toBe("ok");

      // 创建 Session
      const session = await api.createSession("TUI 测试", process.cwd());
      expect(session.id).toBeTruthy();
      expect(session.title).toBe("TUI 测试");

      // 列出 Session
      const sessions = await api.listSessions();
      expect(sessions.length).toBeGreaterThan(0);

      // 获取 Session
      const found = await api.getSession(session.id);
      expect(found.id).toBe(session.id);

      // 创建 Runtime 并发送 Prompt
      const runtime = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: paths.sessions,
        authPath: paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "tui reply" },
        publish: () => {},
        replayStore,
      });
      promptService.register(runtime);

      const promptResult = await api.sendPrompt(session.id, "hello");
      expect(promptResult.status).toBe("accepted");
      expect(promptResult.streamId).toMatch(/^stream-/);

      // 等待 prompt 完成
      const run = runtime.prompt("smoke test");
      await run.completed;

      // 归档 Session
      await api.deleteSession(session.id);

      runtime.dispose();
    } finally {
      await server.stop();
      database.close();
    }
  });

  it("aborts an active stream via the API", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-tui2-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
    const replayStore = new EventReplayStore();
    const promptService = new PromptService();
    const database = openMetadataDatabase(paths.database);
    const sessionIndex = new SessionIndex(database);
    const sessionService = new SessionService(paths, sessionIndex);

    const server = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: { promptService, replayStore, sessionService },
    });

    try {
      const api = new TuiApiClient(`http://127.0.0.1:${server.port}`);
      const session = await api.createSession("Abort 测试", process.cwd());

      const runtime = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: paths.sessions,
        authPath: paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "slow response for testing abort", tokensPerSecond: 5 },
        publish: () => {},
        replayStore,
      });
      promptService.register(runtime);

      // 直接从 runtime 发起 prompt 以确保 streamId 匹配
      const run = runtime.prompt("slow test");
      expect(run.streamId).toMatch(/^stream-/);

      const abortResult = await api.abort(session.id, run.streamId);
      expect(abortResult.status).toBe("accepted");

      runtime.dispose();
    } finally {
      await server.stop();
      database.close();
    }
  });
});
