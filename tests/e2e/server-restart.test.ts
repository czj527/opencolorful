import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { startForegroundServer } from "../../src/server/start.js";

const temporaryDirectories: string[] = [];

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
  it("rebuilds production services and continues persisted history", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });

    const server1 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
    });
    const base1 = `http://127.0.0.1:${server1.port}`;

    const createResponse = await fetch(`${base1}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重启测试", cwd: process.cwd() }),
    });
    expect(createResponse.status).toBe(201);
    const session = (await createResponse.json()) as { id: string };

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
    }

    const server2 = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
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
    }
  }, 20_000);
});
