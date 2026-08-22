import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { ToolPolicy } from "../../src/runtime/tool-policy.js";
import { createServerApp } from "../../src/server/app.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-tools-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();
  return { paths, database, sessionService, promptService, replayStore };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("tool policy", () => {
  it("returns empty for off mode", () => {
    const policy = new ToolPolicy();
    expect(policy.resolveTools("off")).toEqual([]);
  });

  it("returns read-only tools for read-only mode", () => {
    const policy = new ToolPolicy();
    const tools = policy.resolveTools("read-only");
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("find");
    expect(tools).toContain("ls");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("bash");
  });

  it("returns all tools for all mode with confirmed workspace", () => {
    const policy = new ToolPolicy();
    const tools = policy.resolveTools("all", process.cwd(), true);
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
  });

  it("degrades all mode to read-only tools when not confirmed", () => {
    const policy = new ToolPolicy();
    const falseConfirmed = policy.resolveTools("all", process.cwd(), false);
    expect(falseConfirmed).toContain("read");
    expect(falseConfirmed).toContain("grep");
    expect(falseConfirmed).toContain("find");
    expect(falseConfirmed).toContain("ls");
    expect(falseConfirmed).not.toContain("write");
    expect(falseConfirmed).not.toContain("edit");
    expect(falseConfirmed).not.toContain("bash");

    const undefinedConfirmed = policy.resolveTools("all", process.cwd(), undefined);
    expect(undefinedConfirmed).toEqual(falseConfirmed);
  });

  it("throws when cwd does not exist", () => {
    const policy = new ToolPolicy();
    expect(() => policy.resolveTools("all", "/does/not/exist", true)).toThrow("不存在");
  });

  it("shouldDisableAllTools returns true for off mode", () => {
    const policy = new ToolPolicy();
    expect(policy.shouldDisableAllTools("off")).toBe(true);
    expect(policy.shouldDisableAllTools("read-only")).toBe(false);
  });
});

describe("tool events via faux session runtime", () => {
  it("emits no tool events in off mode", async () => {
    const ctx = createContext();
    const events: PlatformEventEnvelope[] = [];

    const runtime = await SessionRuntime.create({
      sessionId: "sess-off",
      cwd: process.cwd(),
      sessionDir: ctx.paths.sessions,
      authPath: ctx.paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "no tools" },
      publish: (e) => events.push(e),
      replayStore: ctx.replayStore,
      noTools: "all",
    });
    ctx.promptService.register(runtime);

    const run = runtime.prompt("test");
    await run.completed;

    // off 模式不应有 tool 事件
    const toolEvents = events.filter((e) => e.type.startsWith("tool."));
    expect(toolEvents.length).toBe(0);

    runtime.dispose();
    ctx.database.close();
  });

  it("passes tools to SessionRuntime via faux path", async () => {
    const ctx = createContext();

    // 验证 SessionRuntime 接受 tools 参数并成功创建
    const runtime = await SessionRuntime.create({
      sessionId: "sess-tools",
      cwd: process.cwd(),
      sessionDir: ctx.paths.sessions,
      authPath: ctx.paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "with tools" },
      publish: () => {},
      replayStore: ctx.replayStore,
      tools: ["read", "grep"],
    });
    expect(runtime.sessionId).toBe("sess-tools");
    runtime.dispose();
    ctx.database.close();
  });
});
