import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { defaultMemoryAgentSettings } from "../../src/contracts/memory.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { createServerApp } from "../../src/server/app.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";

const temporaryDirectories: string[] = [];
const openDatabases: import("better-sqlite3").Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-mem-inj-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({
    id: "a1",
    name: "注入验收",
    baseColor: { persona: "", personality: [], replyStyle: "", innerSetting: "" },
  });
  fs.mkdirSync(path.join(paths.agents, "a1", "memory"), { recursive: true });
  // 长"重要事实"段：默认预算 2500 不截断；250 预算必然截断
  fs.writeFileSync(
    path.join(paths.agents, "a1", "memory", "memory.md"),
    `## 重要事实\n${"用户偏好细节".repeat(200)}`,
    "utf8",
  );
  return { dir, paths, database, sessionService, agentStore };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

/** 灰盒读取 PromptService 注册的 runtime（路由内部 systemPrompt 不对外暴露） */
function runtimeSystemPrompt(promptService: PromptService, sessionId: string): string | undefined {
  const runtime = (promptService as unknown as { sessions: Map<string, SessionRuntime> }).sessions.get(sessionId);
  return runtime?.systemPrompt;
}

async function postMessage(app: ReturnType<typeof createServerApp>["app"], sessionId: string): Promise<Response> {
  return app.request(`http://x/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi" }),
  });
}

describe("injectBudgetChars 接线（评审 P1#7b 复现级测试）", () => {
  it("全局记忆设置 injectBudgetChars=250 → 注入块被截断（修复前 messages.ts 用默认 2500 预算）", async () => {
    const ctx = createContext();
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);
    preferencesStore.update({ memory: { ...defaultMemoryAgentSettings(), injectBudgetChars: 250 } } as never);
    const promptService = new PromptService();
    const replayStore = new EventReplayStore();
    const { app } = createServerApp({
      promptService,
      sessionService: ctx.sessionService,
      replayStore,
      paths: ctx.paths,
      agentStore: ctx.agentStore,
      preferencesStore,
      database: ctx.database,
    });
    const session = ctx.sessionService.create({ title: "接线测试", cwd: process.cwd(), agentId: "a1" });
    const response = await postMessage(app, session.id);
    // 异步处理：202 表示已接受（runtime 在响应前已注册并携带 systemPrompt）
    expect([200, 202]).toContain(response.status);
    const systemPrompt = runtimeSystemPrompt(promptService, session.id);
    expect(systemPrompt).toBeDefined();
    // 记忆注入发生（含规则段与 Memory 头部）且因 250 预算被截断
    expect(systemPrompt).toContain("# Memory");
    expect(systemPrompt).toContain("…（已截断）");
    promptService.dispose();
    ctx.sessionService.closeAll();
  });

  it("无全局设置时走默认预算 2500 → 同内容不截断（对照：证明预算确实来自设置）", async () => {
    const ctx = createContext();
    const promptService = new PromptService();
    const replayStore = new EventReplayStore();
    const { app } = createServerApp({
      promptService,
      sessionService: ctx.sessionService,
      replayStore,
      paths: ctx.paths,
      agentStore: ctx.agentStore,
      database: ctx.database,
    });
    const session = ctx.sessionService.create({ title: "接线对照", cwd: process.cwd(), agentId: "a1" });
    const response = await postMessage(app, session.id);
    expect([200, 202]).toContain(response.status);
    const systemPrompt = runtimeSystemPrompt(promptService, session.id);
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt).toContain("# Memory");
    expect(systemPrompt).not.toContain("…（已截断）");
    promptService.dispose();
    ctx.sessionService.closeAll();
  });
});
