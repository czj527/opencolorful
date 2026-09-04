import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { startForegroundServer } from "../../src/server/start.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";

const temporaryDirectories: string[] = [];

function makeTestResources(paths: ReturnType<typeof getRuntimePaths>) {
  const database = openMetadataDatabase(paths.database);
  const sessionService = new SessionService(paths, new SessionIndex(database));
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();
  return { database, sessionService, promptService, replayStore };
}

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 Prompt 完成超时")), timeoutMs);
    void reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function sendPromptAndCollect(
  baseUrl: string,
  sessionId: string,
  content: string,
): Promise<{ streamId: string; events: PlatformEventEnvelope[] }> {
  const abortController = new AbortController();
  const eventsResponsePromise = fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
    headers: { accept: "text/event-stream" },
    signal: abortController.signal,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(promptResponse.status).toBe(202);
  const accepted = (await promptResponse.json()) as { streamId: string };

  const eventsResponse = await eventsResponsePromise;
  expect(eventsResponse.status).toBe(200);
  if (eventsResponse.body === null) throw new Error("SSE 响应缺少 body");

  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  const events: PlatformEventEnvelope[] = [];
  let buffer = "";
  const deadline = Date.now() + 5_000;

  try {
    while (Date.now() < deadline) {
      const read = await readWithTimeout(reader, 5_000);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data !== "") {
          const event = JSON.parse(data) as PlatformEventEnvelope;
          if (event.streamId === accepted.streamId) events.push(event);
        }
        boundary = buffer.indexOf("\n\n");
      }

      const completed = events.some(
        (event) =>
          event.type === "session.status" &&
          (event.payload as { status?: string }).status === "idle",
      );
      if (completed) break;
    }
  } finally {
    abortController.abort();
    await reader.cancel().catch(() => {});
  }

  expect(events.at(-1)).toMatchObject({
    streamId: accepted.streamId,
    type: "session.status",
    payload: { status: "idle" },
  });
  expect(events.map((event) => event.sequence)).toEqual(
    events.map((_, index) => index + 1),
  );
  return { streamId: accepted.streamId, events };
}

describe("server restart recovery", () => {
  it("rebuilds server wiring and continues persisted history with an explicit faux model", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });

    const first = makeTestResources(paths);
    const sessionHandle = first.sessionService.create({ title: "重启测试", cwd: process.cwd() });
    sessionHandle.selectModel("faux", "faux-1");
    const server1 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: {
        sessionService: first.sessionService,
        promptService: first.promptService,
        replayStore: first.replayStore,
        database: first.database,
      },
    });
    const base1 = `http://127.0.0.1:${server1.port}`;

    const session = { id: sessionHandle.id };

    try {
      await sendPromptAndCollect(base1, session.id, "第一条消息");
      const beforeRestart = await (await fetch(`${base1}/api/sessions/${session.id}`)).json() as {
        messages: string[];
        model: { providerId: string; modelId: string } | null;
      };
      expect(beforeRestart.messages).toEqual(["第一条消息", "已收到您的消息"]);
      expect(beforeRestart.model).toEqual({ providerId: "faux", modelId: "faux-1" });
    } finally {
      await server1.stop();
      first.promptService.dispose();
      first.sessionService.closeAll();
      first.database.close();
    }

    const second = makeTestResources(paths);
    const server2 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
      appOptions: {
        sessionService: second.sessionService,
        promptService: second.promptService,
        replayStore: second.replayStore,
        database: second.database,
      },
    });
    const base2 = `http://127.0.0.1:${server2.port}`;

    try {
      const reopenedResponse = await fetch(`${base2}/api/sessions/${session.id}`);
      expect(reopenedResponse.status).toBe(200);
      const reopened = await reopenedResponse.json() as {
        id: string;
        messages: string[];
        model: { providerId: string; modelId: string } | null;
      };
      expect(reopened.id).toBe(session.id);
      expect(reopened.messages).toEqual(["第一条消息", "已收到您的消息"]);
      expect(reopened.model).toEqual({ providerId: "faux", modelId: "faux-1" });

      await sendPromptAndCollect(base2, session.id, "继续消息");
      const continued = await (await fetch(`${base2}/api/sessions/${session.id}`)).json() as {
        messages: string[];
      };
      expect(continued.messages).toEqual([
        "第一条消息",
        "已收到您的消息",
        "继续消息",
        "已收到您的消息",
      ]);

      const sessionJsonl = fs.readFileSync(
        fs.readdirSync(paths.sessions).map((file) => path.join(paths.sessions, file))[0]!,
        "utf8",
      );
      expect(sessionJsonl).not.toContain("faux-key");
      expect(fs.readFileSync(paths.authFile, "utf8")).not.toContain("faux-key");
      if (fs.existsSync(paths.providerSettings)) {
        expect(fs.readFileSync(paths.providerSettings, "utf8")).not.toContain("faux-key");
      }
    } finally {
      await server2.stop();
      second.promptService.dispose();
      second.sessionService.closeAll();
      second.database.close();
    }
  }, 20_000);
});
