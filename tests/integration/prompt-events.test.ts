import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { createServerApp } from "../../src/server/app.js";
import { createInMemorySession } from "../../src/pi-sdk/index.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { UsageRecorder } from "../../src/runtime/usage-recorder.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import { openMetadataDatabase } from "../../src/storage/database.js";

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

async function createFailingRuntime() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-prompt-failure-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const events: PlatformEventEnvelope[] = [];
  const replayStore = new EventReplayStore();
  const database = openMetadataDatabase(paths.database);
  const usageStore = new UsageStore(database);
  const usageRecorder = new UsageRecorder(replayStore, usageStore, () => ({
    providerId: "faux",
    modelId: "faux-1",
  }));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: paths.authFile,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://localhost:0",
    api: faux.provider as never,
    streamSimple: faux.provider.stream as never,
    models: [{
      id: "faux-1",
      name: "Faux Model",
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_000,
    }],
  });
  await modelRuntime.setRuntimeApiKey("faux", "dummy-key");
  const model = modelRuntime.getModel("faux", "faux-1");
  if (model === undefined) throw new Error("faux 模型未注册");
  faux.setResponses([{
    ...fauxAssistantMessage(""),
    stopReason: "error",
    errorMessage: "401 Unauthorized",
  }]);
  const modelService = {
    resolveModel: () => ({ runtime: modelRuntime, model }),
    getRuntime: () => ({ resolveModel: () => ({ runtime: modelRuntime, model }) }),
  };
  const runtime = await SessionRuntime.create({
    sessionId: "session-prompt-failure",
    cwd: directory,
    authPath: paths.authFile,
    publish: (event) => events.push(event),
    replayStore,
    sessionHandle: createInMemorySession(directory),
    modelService: modelService as never,
    resolveProviderId: "faux",
    resolveModelId: "faux-1",
  });
  return { runtime, events, replayStore, usageStore, usageRecorder, database };
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

  it("emits only turn.failed for an assistant error and skips success side effects", async () => {
    const { runtime, events, replayStore, usageStore, usageRecorder, database } = await createFailingRuntime();
    const run = runtime.prompt("fail");
    try {
      await run.completed;
      await new Promise((resolve) => setImmediate(resolve));

      const terminalTypes = events
        .filter((event) =>
          event.streamId === run.streamId &&
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled" ||
            event.type === "turn.interrupted"),
        )
        .map((event) => event.type);
      expect(terminalTypes).toEqual(["turn.failed"]);
      // A8a：失败 turn 也落一行 source=main 账目（status=failed；usage 无则 0 =
      // 无账目），"所有模型使用量可查"不再漏失败调用；turns 计 main 行数。
      expect(usageStore.sessionTotals("session-prompt-failure").turns).toBe(1);
      expect(replayStore.getSince(run.streamId, 0).events.map((event) => event.type)).not.toContain("turn.completed");
    } finally {
      runtime.dispose();
      usageRecorder.dispose();
      database.close();
    }
  });

  it("rejects stale aborts and reports repeated aborts without affecting a new stream", async () => {
    const { runtime, events } = await createRuntime({
      response: "abcdefghijklmnopqrstuvwxyz",
      tokensPerSecond: 20,
    });
    const first = runtime.prompt("first");
    expect(runtime.abort("stream-stale")).toEqual({ status: "rejected" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.abort(first.streamId).status).toBe("accepted");
    await first.completed;
    expect(
      events
        .filter((event) =>
          event.streamId === first.streamId &&
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled" ||
            event.type === "turn.interrupted"),
        )
        .map((event) => event.type),
    ).toEqual(["turn.cancelled"]);
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
