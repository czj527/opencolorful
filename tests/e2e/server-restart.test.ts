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
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});

describe("server restart recovery", () => {
  it("rebuilds services from disk and continues a persisted session", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });

    // ─── 第一次启动 ───
    const db1 = openMetadataDatabase(paths.database);
    const index1 = new SessionIndex(db1);
    const store1 = new ProviderStore(paths.providerSettings);
    const sessionService1 = new SessionService(paths, index1);
    const promptService1 = new PromptService();
    const replayStore1 = new EventReplayStore();

    const server1 = await startForegroundServer({
      host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION,
      appOptions: { promptService: promptService1, replayStore: replayStore1, sessionService: sessionService1 },
    });
    const base1 = `http://127.0.0.1:${server1.port}`;

    // 创建 Session（通过 HTTP）
    const r1 = await fetch(`${base1}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重启测试", cwd: process.cwd() }),
    });
    expect(r1.status).toBe(201);
    const session = (await r1.json()) as { id: string; title: string };
    const sessionId = session.id;

    // 创建 Runtime 并发送第一条消息
    const runtime = await SessionRuntime.create({
      sessionId, cwd: process.cwd(), sessionDir: paths.sessions,
      authPath: paths.authFile, providerId: "faux", modelId: "faux-1",
      faux: { response: "第一条回复" },
      publish: () => {}, replayStore: replayStore1,
    });
    promptService1.register(runtime);
    const runResp = await fetch(`${base1}/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(runResp.status).toBe(202);

    // 停止
    await server1.stop();
    runtime.dispose();
    sessionService1.closeAll();
    db1.close();

    // ─── 第二次启动（全新服务实例）───
    const db2 = openMetadataDatabase(paths.database);
    const index2 = new SessionIndex(db2);
    const sessionService2 = new SessionService(paths, index2);
    const promptService2 = new PromptService();
    const replayStore2 = new EventReplayStore();

    const server2 = await startForegroundServer({
      host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION,
      appOptions: { promptService: promptService2, replayStore: replayStore2, sessionService: sessionService2 },
    });

    try {
      const base2 = `http://127.0.0.1:${server2.port}`;

      // Session 重启后可读
      const getResp = await fetch(`${base2}/api/sessions/${sessionId}`);
      expect(getResp.status).toBe(200);
      const reopened = (await getResp.json()) as { id: string };
      expect(reopened.id).toBe(sessionId);

      // 继续发送 Prompt
      const msgResp = await fetch(`${base2}/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "继续" }),
      });
      expect(msgResp.status).toBe(202);

      sessionService2.closeAll();
    } finally {
      await server2.stop();
      db2.close();
    }
  }, 20_000);
});
