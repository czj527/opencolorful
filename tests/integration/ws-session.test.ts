import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { startForegroundServer } from "../../src/server/start.js";
import { ClientRegistry } from "../../src/server/ws/client-registry.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";

const temporaryDirectories: string[] = [];

function createWsContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-ws-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const replayStore = new EventReplayStore();
  const promptService = new PromptService();
  const registry = new ClientRegistry();

  return { paths, replayStore, promptService, registry };
}

async function startWsServer(
  paths: ReturnType<typeof getRuntimePaths>,
  options: {
    replayStore: EventReplayStore;
    promptService: PromptService;
    registry: ClientRegistry;
    sessionService?: SessionService;
  },
) {
  return startForegroundServer({
    host: "127.0.0.1",
    port: 0,
    paths,
    version: PLATFORM_VERSION,
    appOptions: {
      promptService: options.promptService,
      replayStore: options.replayStore,
      wsRegistry: options.registry,
      wsPromptService: options.promptService,
      wsReplayStore: options.replayStore,
      ...(options.sessionService !== undefined
        ? { sessionService: options.sessionService }
        : {}),
    },
  });
}

async function createWsRuntime(
  promptService: PromptService,
  replayStore: EventReplayStore,
  paths: ReturnType<typeof getRuntimePaths>,
) {
  return SessionRuntime.create({
    sessionId: "session-ws",
    cwd: process.cwd(),
    sessionDir: paths.sessions,
    authPath: paths.authFile,
    providerId: "faux",
    modelId: "faux-1",
    faux: { response: "ws reply", tokensPerSecond: 50 },
    publish: () => {},
    replayStore,
  }).then((runtime) => {
    promptService.register(runtime);
    return runtime;
  });
}

async function connectWs(
  port: number,
  token: string,
): Promise<{ ws: WebSocket; received: string[]; close: () => void }> {
  const received: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    received.push(typeof data === "string" ? data : new TextDecoder().decode(data as Buffer));
  });

  return {
    ws,
    received,
    close: () => {
      ws.close();
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("WebSocket session control", () => {
  it("subscribes to a persisted session before its Runtime is created", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const database = openMetadataDatabase(paths.database);
    const sessionService = new SessionService(paths, new SessionIndex(database));
    const session = sessionService.create({ title: "WS 新会话", cwd: process.cwd() });
    const server = await startWsServer(paths, {
      replayStore,
      promptService,
      registry,
      sessionService,
    });
    let client: Awaited<ReturnType<typeof connectWs>> | undefined;

    try {
      client = await connectWs(server.port, server.token);
      client.ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "before-runtime",
        type: "session.subscribe",
        sessionId: session.id,
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.received.map((raw) => JSON.parse(raw))).toContainEqual({
        type: "ack",
        requestId: "before-runtime",
        status: "accepted",
      });
    } finally {
      client?.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await server.stop();
      sessionService.closeAll();
      database.close();
    }
  });

  it("allows client to subscribe and receive events for a session", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const runtime = await createWsRuntime(promptService, replayStore, paths);
    const server = await startWsServer(paths, { replayStore, promptService, registry });

    try {
      const { ws, received, close } = await connectWs(server.port, server.token);

      // 订阅 session
      ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        type: "session.subscribe",
        sessionId: "session-ws",
      }));

      // 等待 ack
      await new Promise((r) => setTimeout(r, 50));

      // 触发 prompt 以产生事件
      const run = runtime.prompt("ws test");
      await run.completed;

      // 等待事件到达
      await new Promise((r) => setTimeout(r, 100));

      const messages = received.map((raw) => {
        try { return JSON.parse(raw); } catch { return null; }
      });

      // 应有 ack 响应
      const ackMessages = messages.filter((m) => m !== null && m.type === "ack");
      expect(ackMessages.length).toBeGreaterThan(0);
      expect(ackMessages[0]).toMatchObject({ requestId: "r1", status: "accepted" });

      // 应有事件消息
      const eventMessages = messages.filter((m) => m !== null && m.type === "event");
      expect(eventMessages.length).toBeGreaterThan(0);

      close();
      runtime.dispose();
    } finally {
      await server.stop();
    }
  });

  it("does not deliver events to unsubscribed clients", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const runtime = await createWsRuntime(promptService, replayStore, paths);
    const server = await startWsServer(paths, { replayStore, promptService, registry });

    try {
      // 客户端 A 订阅，客户端 B 不订阅
      const clientA = await connectWs(server.port, server.token);
      const clientB = await connectWs(server.port, server.token);

      clientA.ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        type: "session.subscribe",
        sessionId: "session-ws",
      }));

      await new Promise((r) => setTimeout(r, 50));

      const run = runtime.prompt("isolation test");
      await run.completed;

      await new Promise((r) => setTimeout(r, 100));

      const aEvents = clientA.received.filter((r) => {
        try { return JSON.parse(r).type === "event"; } catch { return false; }
      });
      const bEvents = clientB.received.filter((r) => {
        try { return JSON.parse(r).type === "event"; } catch { return false; }
      });

      expect(aEvents.length).toBeGreaterThan(0);
      expect(bEvents.length).toBe(0);

      clientA.close();
      clientB.close();
      runtime.dispose();
    } finally {
      await server.stop();
    }
  });

  it("sends abort command and receives ack result", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const runtime = await createWsRuntime(promptService, replayStore, paths);
    const server = await startWsServer(paths, { replayStore, promptService, registry });

    try {
      const { ws, received, close } = await connectWs(server.port, server.token);

      // 发起一个慢速 prompt
      runtime.prompt("slow test");

      // 发送 abort
      ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        type: "session.abort",
        sessionId: "session-ws",
      }));

      await new Promise((r) => setTimeout(r, 100));

      const messages = received.map((raw) => {
        try { return JSON.parse(raw); } catch { return null; }
      });
      const ackMessages = messages.filter((m) => m !== null && m.type === "ack");
      expect(ackMessages.length).toBeGreaterThan(0);

      close();
      runtime.dispose();
    } finally {
      await server.stop();
    }
  });

  it("supports stream resume for reconnection", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const runtime = await createWsRuntime(promptService, replayStore, paths);
    
    // 先产生一些事件到 replay store
    const run = runtime.prompt("resume test");
    await run.completed;

    const streamsForSession = replayStore.listSessionStreams("session-ws");
    expect(streamsForSession.length).toBeGreaterThan(0);
    const streamId = streamsForSession[0]!;

    const server = await startWsServer(paths, { replayStore, promptService, registry });

    try {
      const { ws, received, close } = await connectWs(server.port, server.token);

      // 必须先订阅才能 resume
      ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r0",
        type: "session.subscribe",
        sessionId: "session-ws",
      }));
      await new Promise((r) => setTimeout(r, 30));

      // 请求 resume
      ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        type: "stream.resume",
        sessionId: "session-ws",
        streamId,
        lastSequence: 0,
      }));

      await new Promise((r) => setTimeout(r, 100));

      const messages = received.map((raw) => {
        try { return JSON.parse(raw); } catch { return null; }
      });
      const eventMessages = messages.filter((m) => m !== null && m.type === "event");
      expect(eventMessages.length).toBeGreaterThan(0);

      close();
      runtime.dispose();
    } finally {
      await server.stop();
    }
  });

  it("cleans up client subscriptions on ws close", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const runtime = await createWsRuntime(promptService, replayStore, paths);
    const server = await startWsServer(paths, { replayStore, promptService, registry });

    try {
      expect(registry.clientCount).toBe(0);
      const { ws, close } = await connectWs(server.port, server.token);

      ws.send(JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        type: "session.subscribe",
        sessionId: "session-ws",
      }));

      await new Promise((r) => setTimeout(r, 50));
      expect(registry.clientCount).toBe(1);
      expect(registry.subscriptionCount).toBe(1);

      close();
      await new Promise((r) => setTimeout(r, 50));
      expect(registry.clientCount).toBe(0);
      expect(registry.subscriptionCount).toBe(0);

      runtime.dispose();
    } finally {
      await server.stop();
    }
  });

  it("stops promptly while a WebSocket client is still connected", async () => {
    const { paths, replayStore, promptService, registry } = createWsContext();
    const server = await startWsServer(paths, { replayStore, promptService, registry });
    const client = await connectWs(server.port, server.token);

    const stopPromise = server.stop();
    const stoppedPromptly = await Promise.race([
      stopPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!stoppedPromptly) client.close();
    await stopPromise;

    expect(stoppedPromptly).toBe(true);
  });
});
