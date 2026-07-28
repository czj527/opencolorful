import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

function createRuntime(options: { response: string; tokensPerSecond?: number }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-prompt-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const events: PlatformEventEnvelope[] = [];
  return SessionRuntime.create({
    sessionId: "session-prompt",
    cwd: process.cwd(),
    sessionDir: paths.sessions,
    authPath: paths.authFile,
    providerId: "faux",
    modelId: "faux-1",
    faux: options,
    publish: (event) => events.push(event),
  }).then((runtime) => ({ runtime, events }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("prompt event normalization", () => {
  it("streams PI text events as ordered platform envelopes", async () => {
    const { runtime, events } = await createRuntime({ response: "faux reply" });
    const run = runtime.prompt("hello");

    expect(run.streamId).toMatch(/^stream-/);
    await run.completed;

    expect(events.map((event) => event.type)).toEqual([
      "session.status",
      "turn.started",
      "message.started",
      "message.delta",
      "message.completed",
      "turn.completed",
      "session.status",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.find((event) => event.type === "message.delta")?.payload).toMatchObject({
      role: "assistant",
      delta: "faux reply",
    });
    runtime.dispose();
  });

  it("rejects stale aborts and reports repeated aborts without affecting a new stream", async () => {
    const { runtime } = await createRuntime({
      response: "abcdefghijklmnopqrstuvwxyz",
      tokensPerSecond: 20,
    });
    const first = runtime.prompt("first");
    expect(runtime.abort("stream-stale")).toEqual({ status: "rejected" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.abort(first.streamId).status).toBe("accepted");
    await first.completed;
    expect(runtime.abort(first.streamId)).toEqual({ status: "already-stopped" });

    const second = runtime.prompt("second");
    expect(runtime.abort(first.streamId)).toEqual({ status: "rejected" });
    await second.completed;
    runtime.dispose();
  });

  it("accepts Prompt and Abort through the Server routes", async () => {
    const { runtime } = await createRuntime({ response: "route reply", tokensPerSecond: 10 });
    const promptService = new PromptService();
    promptService.register(runtime);
    const { app } = createServerApp({ promptService });
    const response = await app.request("http://local/api/sessions/session-prompt/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "route prompt" }),
    });
    expect(response.status).toBe(202);
    const { streamId } = (await response.json()) as { streamId: string };
    expect(
      await app.request("http://local/api/sessions/session-prompt/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: "stale-stream" }),
      }),
    ).toHaveProperty("status", 200);
    expect((await app.request("http://local/api/sessions/session-prompt/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId }),
    })).status).toBe(200);
    promptService.dispose();
  });
});
