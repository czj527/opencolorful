import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];

function createRuntime(options: {
  response: string;
  tokensPerSecond?: number;
  replayStore?: EventReplayStore;
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-sse-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
  const events: PlatformEventEnvelope[] = [];
  return SessionRuntime.create({
    sessionId: "session-sse",
    cwd: process.cwd(),
    sessionDir: paths.sessions,
    authPath: paths.authFile,
    providerId: "faux",
    modelId: "faux-1",
    faux: {
      response: options.response,
      ...(options.tokensPerSecond !== undefined
        ? { tokensPerSecond: options.tokensPerSecond }
        : {}),
    },
    publish: (event) => events.push(event),
    ...(options.replayStore !== undefined
      ? { replayStore: options.replayStore }
      : {}),
  }).then((runtime) => ({ runtime, events, paths }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("SSE event replay", () => {
  it("streams PI events through the replay store in order", async () => {
    const replayStore = new EventReplayStore();
    const { runtime, events } = await createRuntime({
      response: "hello from sse",
      replayStore,
    });
    const promptService = new PromptService();
    promptService.register(runtime);

    const run = runtime.prompt("test prompt");
    await run.completed;

    // replay store 已缓存事件
    const streamsForSession = replayStore.listSessionStreams("session-sse");
    expect(streamsForSession.length).toBeGreaterThan(0);

    const streamId = streamsForSession[0]!;
    const result = replayStore.getSince(streamId, 0);
    expect(result.reset).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.map((e) => e.type)).toEqual(events.map((e) => e.type));

    promptService.dispose();
  });

  it("supports reconnection with sequence-based replay", async () => {
    const replayStore = new EventReplayStore();
    const { runtime } = await createRuntime({
      response: "reconnect test",
      replayStore,
    });
    const promptService = new PromptService();
    promptService.register(runtime);

    const run = runtime.prompt("reconnect");
    await run.completed;

    const { app } = createServerApp({ promptService, replayStore });

    // SSE 端点返回有效的 text/event-stream 响应
    const controller = new AbortController();
    const response = await app.request(
      "http://local/api/sessions/session-sse/events?sinceSeq=0",
      {
        headers: { "accept": "text/event-stream" },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // 读取初始数据块（包含已有事件的重放），然后断开
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let body = "";
    if (reader) {
      try {
        const { value } = await reader.read();
        if (value) body = decoder.decode(value, { stream: true });
      } finally {
        reader.releaseLock();
      }
    }
    controller.abort();
    expect(body).toContain("session.status");

    // 验证 replay store 支持基于 sequence 的重连
    const streamsForSession = replayStore.listSessionStreams("session-sse");
    const streamId = streamsForSession[0]!;
    const allEvents = replayStore.getSince(streamId, 0).events;
    expect(allEvents.length).toBeGreaterThan(0);

    // 取中间序号作为断点
    const midSeq = allEvents[allEvents.length > 3 ? 3 : 1]!.sequence;
    const replayed = replayStore.getSince(streamId, midSeq);
    expect(replayed.reset).toBe(false);
    // 重放应只包含 midSeq 之后的事件
    expect(replayed.events.length).toBeGreaterThan(0);
    for (const event of replayed.events) {
      expect(event.sequence).toBeGreaterThan(midSeq);
    }

    promptService.dispose();
  });

  it("uses the stream prefix in Last-Event-ID to replay only that stream", async () => {
    const replayStore = new EventReplayStore();
    const promptService = new PromptService();
    for (const streamId of ["stream-a", "stream-b"]) {
      for (let sequence = 1; sequence <= 2; sequence += 1) {
        replayStore.publish({
          protocolVersion: 1,
          eventId: `${streamId}-${sequence}`,
          sessionId: "session-cursor",
          streamId,
          sequence,
          timestamp: new Date().toISOString(),
          type: "message.delta",
          payload: { role: "assistant", delta: `${streamId}-${sequence}` },
        } as PlatformEventEnvelope);
      }
    }

    const { app } = createServerApp({ promptService, replayStore });
    const controller = new AbortController();
    const response = await app.request(
      "http://local/api/sessions/session-cursor/events",
      {
        headers: {
          accept: "text/event-stream",
          "Last-Event-ID": "stream-b:1",
        },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      while (!body.includes("stream-b-2")) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }

    expect(body).toContain("stream-b-2");
    expect(body).not.toContain("stream-b-1");
    expect(body).not.toContain("stream-a-");
  });

  it("does not lose an event published between the replay snapshot and live delivery", async () => {
    const liveEvent = {
      protocolVersion: 1,
      eventId: "race-2",
      sessionId: "session-race",
      streamId: "stream-race",
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: "message.delta",
      payload: { role: "assistant", delta: "live" },
    } as PlatformEventEnvelope;
    class RacingReplayStore extends EventReplayStore {
      private injected = false;

      override getSince(streamId: string, sinceSeq: number) {
        const result = super.getSince(streamId, sinceSeq);
        if (!this.injected) {
          this.injected = true;
          this.publish(liveEvent);
        }
        return result;
      }
    }

    const replayStore = new RacingReplayStore();
    replayStore.publish({ ...liveEvent, eventId: "race-1", sequence: 1 });
    const { app } = createServerApp({
      promptService: new PromptService(),
      replayStore,
    });
    const controller = new AbortController();
    const response = await app.request(
      "http://local/api/sessions/session-race/events",
      { headers: { accept: "text/event-stream" }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      const deadline = Date.now() + 100;
      while (Date.now() < deadline && !body.includes("race-2")) {
        const read = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20)),
        ]);
        if (read === undefined || read.done) continue;
        body += decoder.decode(read.value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }

    expect(body).toContain("race-1");
    expect(body).toContain("race-2");
  });

  it("reports reset when cache overflows for a stream", async () => {
    const replayStore = new EventReplayStore();

    // 手动发布超过 1000 个事件到同一 stream
    for (let i = 1; i <= 1_200; i++) {
      replayStore.publish({
        protocolVersion: 1,
        eventId: `e-${i}`,
        sessionId: "session-overflow",
        streamId: "stream-overflow",
        sequence: i,
        timestamp: new Date().toISOString(),
        type: "message.delta",
        payload: { role: "assistant", delta: `msg-${i}` },
      } as PlatformEventEnvelope);
    }

    // 因为缓存只保留最后 1000 条（已截断），请求 sinceSeq=0 应 reset
    const result = replayStore.getSince("stream-overflow", 0);
    expect(result.reset).toBe(true);
    // 但应返回可用的事件（最后 1000 条）
    expect(result.events.length).toBe(1_000);
    // 最老的事件序号应该是 201
    expect(result.events[0]!.sequence).toBe(201);

    // 请求 sinceSeq=150 应该也 reset（事件 150 已被丢弃）
    const earlyResult = replayStore.getSince("stream-overflow", 150);
    expect(earlyResult.reset).toBe(true);

    // 请求 sinceSeq=1100 应该正常返回（在缓存范围内）
    const lateResult = replayStore.getSince("stream-overflow", 1_100);
    expect(lateResult.reset).toBe(false);
    expect(lateResult.events.length).toBe(100); // 1200 - 1100 = 100
  });

  it("bounds the number of retained streams", () => {
    const replayStore = new EventReplayStore();
    for (let index = 0; index < 101; index += 1) {
      replayStore.publish({
        protocolVersion: 1,
        eventId: `stream-event-${index}`,
        sessionId: "session-bounded",
        streamId: `stream-${index}`,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "session.status",
        payload: { status: "idle" },
      } as PlatformEventEnvelope);
    }

    expect(replayStore.listSessionStreams("session-bounded")).toHaveLength(100);
    expect(replayStore.getSince("stream-0", 0).reset).toBe(true);
  });

  it("publish does not block when no subscribers are connected", async () => {
    const replayStore = new EventReplayStore();

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      replayStore.publish({
        protocolVersion: 1,
        eventId: `fast-${i}`,
        sessionId: "session-fast",
        streamId: "stream-fast",
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        type: "message.delta",
        payload: { role: "assistant", delta: `fast-${i}` },
      } as PlatformEventEnvelope);
    }
    const elapsed = Date.now() - start;

    // 100 次 publish 应在 100ms 内完成（没有慢订阅者）
    expect(elapsed).toBeLessThan(500);
  });

  it("subscriber receives real-time events and unsubscribe stops delivery", async () => {
    const replayStore = new EventReplayStore();
    const received: PlatformEventEnvelope[] = [];

    const unsubscribe = replayStore.subscribe((event) => received.push(event));

    replayStore.publish({
      protocolVersion: 1,
      eventId: "sub-1",
      sessionId: "session-sub",
      streamId: "stream-sub",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "message.delta",
      payload: { role: "assistant", delta: "hello" },
    } as PlatformEventEnvelope);

    await new Promise((r) => setImmediate(r));
    expect(received.length).toBe(1);

    unsubscribe();

    replayStore.publish({
      protocolVersion: 1,
      eventId: "sub-2",
      sessionId: "session-sub",
      streamId: "stream-sub",
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: "message.delta",
      payload: { role: "assistant", delta: "world" },
    } as PlatformEventEnvelope);

    await new Promise((r) => setImmediate(r));
    // unsubscribe 后不再收到事件
    expect(received.length).toBe(1);
  });

  it("isolates subscriber exceptions", async () => {
    const replayStore = new EventReplayStore();
    const received: string[] = [];
    replayStore.subscribe(() => {
      throw new Error("subscriber failed");
    });
    replayStore.subscribe((event) => received.push(event.eventId));

    replayStore.publish({
      protocolVersion: 1,
      eventId: "isolated-event",
      sessionId: "session-isolated",
      streamId: "stream-isolated",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "session.status",
      payload: { status: "idle" },
    } as PlatformEventEnvelope);
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toEqual(["isolated-event"]);
  });

  it("returns 404 for SSE on non-existent session when sessionService is provided", async () => {
    const replayStore = new EventReplayStore();
    const promptService = new PromptService();
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: os.tmpdir() });
    const db = openMetadataDatabase(paths.database);
    const idx = new SessionIndex(db);
    const { SessionService: Svc } = await import("../../src/runtime/session-service.js");
    const sessionService = new Svc(paths, idx);
    const { app } = createServerApp({ promptService, replayStore, sessionService });

    const response = await app.request(
      "http://local/api/sessions/missing-session/events",
      { headers: { "accept": "text/event-stream" } },
    );
    expect(response.status).toBe(404);
    db.close();
  });
});
