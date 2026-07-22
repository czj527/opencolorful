import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { PLATFORM_VERSION } from "../../src/index.js";
import { startForegroundServer, type RunningServer } from "../../src/server/start.js";

const temporaryDirectories: string[] = [];
const servers: RunningServer[] = [];
const fixtures: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const fixture of fixtures.splice(0)) {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-tool-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startProviderFixture(): Promise<{ port: number; calls: () => number }> {
  let callCount = 0;
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      callCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (callCount === 1) {
        response.write(streamChunk({ role: "assistant" }));
        response.write(streamChunk({
          tool_calls: [{
            index: 0,
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: '{"path":"target.txt"}' },
          }],
        }));
        response.write(streamChunk({}, "tool_calls"));
      } else {
        response.write(streamChunk({ role: "assistant", content: "tool complete" }));
        response.write(streamChunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  fixtures.push(fixture);
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  const address = fixture.address();
  if (address === null || typeof address === "string") throw new Error("Fixture 端口不可用");
  return { port: address.port, calls: () => callCount };
}

async function collectUntilIdle(response: Response): Promise<PlatformEventEnvelope[]> {
  if (response.body === null) throw new Error("SSE body 缺失");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: PlatformEventEnvelope[] = [];
  let buffer = "";
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("等待 SSE 超时")), 8_000),
      ),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as PlatformEventEnvelope;
      events.push(event);
      if (
        event.type === "session.status" &&
        (event.payload as { status?: string }).status === "idle"
      ) {
        await reader.cancel();
        return events;
      }
    }
  }
  throw new Error("未收到 idle 事件");
}

describe("real provider and PI tools", () => {
  it("runs a read-only PI tool from the persisted session workspace", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-real-tool-"));
    temporaryDirectories.push(home);
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "target.txt"), "WORKSPACE_CONTENT\n", "utf8");
    const fixture = await startProviderFixture();
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: home });
    const server = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const providerResponse = await fetch(`${baseUrl}/api/settings/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: {
          providerId: "fixture-provider",
          name: "Fixture Provider",
          protocol: "openai-completions",
          baseUrl: `http://127.0.0.1:${fixture.port}/v1`,
          models: [{
            modelId: "fixture-model",
            name: "Fixture Model",
            capabilities: {
              reasoning: false,
              input: ["text"],
              contextWindow: 4_096,
              maxTokens: 512,
            },
          }],
        },
        apiKey: "fixture-key",
      }),
    });
    expect(providerResponse.status).toBe(200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "真实工具测试",
        cwd: workspace,
        toolMode: "read-only",
        workspaceCwd: workspace,
      }),
    });
    expect(createResponse.status).toBe(201);
    const session = (await createResponse.json()) as { id: string };
    const modelResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "fixture-provider", modelId: "fixture-model" }),
    });
    expect(modelResponse.status).toBe(200);

    const abortController = new AbortController();
    const eventResponsePromise = fetch(`${baseUrl}/api/sessions/${session.id}/events`, {
      headers: { accept: "text/event-stream" },
      signal: abortController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const promptResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "读取 target.txt" }),
    });
    expect(promptResponse.status).toBe(202);
    const events = await collectUntilIdle(await eventResponsePromise);
    abortController.abort();

    const toolCompleted = events.find((event) => event.type === "tool.completed");
    expect(toolCompleted).toBeDefined();
    expect(toolCompleted?.payload).toMatchObject({ isError: false });
    expect(JSON.stringify(toolCompleted?.payload)).toContain("WORKSPACE_CONTENT");
    expect(fixture.calls()).toBe(2);

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
    });
    servers.push(restarted);
    const restartedBaseUrl = `http://127.0.0.1:${restarted.port}`;
    const reopenedResponse = await fetch(
      `${restartedBaseUrl}/api/sessions/${session.id}`,
    );
    expect(reopenedResponse.status).toBe(200);
    expect(await reopenedResponse.json()).toMatchObject({
      id: session.id,
      model: { providerId: "fixture-provider", modelId: "fixture-model" },
      toolMode: "read-only",
      workspaceCwd: workspace,
      thinkingLevel: "medium",
    });

    const resumedAbortController = new AbortController();
    const resumedEventsPromise = fetch(
      `${restartedBaseUrl}/api/sessions/${session.id}/events`,
      {
        headers: { accept: "text/event-stream" },
        signal: resumedAbortController.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumedPrompt = await fetch(
      `${restartedBaseUrl}/api/sessions/${session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "继续对话" }),
      },
    );
    expect(resumedPrompt.status).toBe(202);
    const resumedEvents = await collectUntilIdle(await resumedEventsPromise);
    resumedAbortController.abort();
    expect(resumedEvents.some((event) => event.type === "message.delta")).toBe(true);
    expect(fixture.calls()).toBe(3);
  }, 20_000);
});
