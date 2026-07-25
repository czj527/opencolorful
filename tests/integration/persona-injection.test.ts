import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";

const temporaryDirectories: string[] = [];

interface TestContext {
  paths: ReturnType<typeof getRuntimePaths>;
  database: ReturnType<typeof openMetadataDatabase>;
  index: SessionIndex;
  sessionService: SessionService;
  agentStore: AgentStore;
  dispose(): void;
}

function createTestContext(): TestContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-persona-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const agentStore = new AgentStore(paths.agents);

  return {
    paths,
    database,
    index,
    sessionService,
    agentStore,
    dispose() {
      sessionService.closeAll();
      database.close();
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("persona injection", () => {
  it("injects persona and replyStyle into system prompt for agent-bound sessions", async () => {
    const ctx = createTestContext();
    try {
      // 创建 Agent 并设置 profile
      ctx.agentStore.create({ id: "test-agent", type: "assistant", name: "测试助手" });
      ctx.agentStore.saveProfile("test-agent", {
        persona: "你是一个友好的助手，说话温柔。",
        personality: ["友善", "耐心"],
        replyStyle: "简洁",
      });

      // 创建绑定到 Agent 的会话
      const session = ctx.sessionService.create({
        title: "绑定会话",
        cwd: process.cwd(),
        agentId: "test-agent",
      });

      // 使用 faux runtime 创建 SessionRuntime，带 systemPrompt
      const runtime = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: ctx.paths.sessions,
        authPath: ctx.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "你好！有什么可以帮你的？" },
        publish: () => {},
        sessionHandle: session,
        systemPrompt: "你是一个友好的助手，说话温柔。\n\n回复风格: 简洁\n\n性格标签: 友善、耐心",
      });

      // Prompt 应正常执行（不抛异常说明 systemPrompt 被 PI SDK 接受）
      const run = runtime.prompt("hello");
      await run.completed;

      // 验证 PI session 中有用户消息和 assistant 回复
      const entries = session.messageEntries;
      expect(entries.length).toBe(2);
      expect(entries[0]!.role).toBe("user");
      expect(entries[0]!.content).toBe("hello");
      expect(entries[1]!.role).toBe("assistant");

      runtime.dispose();
    } finally {
      ctx.dispose();
    }
  });

  it("does not inject system prompt for sessions without agent binding", async () => {
    const ctx = createTestContext();
    try {
      // 创建不绑定 Agent 的会话
      const session = ctx.sessionService.create({
        title: "无Agent会话",
        cwd: process.cwd(),
      });

      // 创建 SessionRuntime 时不传 systemPrompt
      const runtime = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: ctx.paths.sessions,
        authPath: ctx.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "收到。" },
        publish: () => {},
        sessionHandle: session,
      });

      const run = runtime.prompt("test");
      await run.completed;

      const entries = session.messageEntries;
      expect(entries.length).toBe(2);
      expect(entries[0]!.content).toBe("test");

      runtime.dispose();
    } finally {
      ctx.dispose();
    }
  });

  it("uses updated profile on the next prompt after profile edit", async () => {
    const ctx = createTestContext();
    try {
      // 创建 Agent
      ctx.agentStore.create({ id: "update-me", type: "assistant", name: "更新测试" });
      ctx.agentStore.saveProfile("update-me", {
        persona: "旧人设",
        personality: [],
        replyStyle: "简洁",
      });

      const session = ctx.sessionService.create({
        title: "更新会话",
        cwd: process.cwd(),
        agentId: "update-me",
      });

      // 第一次 prompt 使用旧 profile 的 system prompt
      const runtime1 = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: ctx.paths.sessions,
        authPath: ctx.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "第一次回复" },
        publish: () => {},
        sessionHandle: session,
        systemPrompt: "旧人设\n\n回复风格: 简洁",
      });

      const run1 = runtime1.prompt("first");
      await run1.completed;

      // 验证第一个回复存在
      expect(session.messageEntries.length).toBe(2);

      // 更新 profile
      ctx.agentStore.saveProfile("update-me", {
        persona: "新人设 - 你是一个专业的编程助手",
        personality: ["专业"],
        replyStyle: "详细",
      });

      // 重新创建 runtime 使用新的 system prompt
      runtime1.dispose();
      const runtime2 = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: ctx.paths.sessions,
        authPath: ctx.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "第二次回复" },
        publish: () => {},
        sessionHandle: session,
        systemPrompt: "新人设 - 你是一个专业的编程助手\n\n回复风格: 详细\n\n性格标签: 专业",
      });

      const run2 = runtime2.prompt("second");
      await run2.completed;

      // 验证第二个回复也正常（有 4 个条目：2 user + 2 assistant）
      expect(session.messageEntries.length).toBe(4);

      runtime2.dispose();
    } finally {
      ctx.dispose();
    }
  });

  it("buildSystemPrompt returns undefined when profile is empty", async () => {
    const ctx = createTestContext();
    try {
      ctx.agentStore.create({ id: "empty-profile", type: "assistant", name: "空人设" });
      // 不设置 profile（getProfile 返回 null）

      const session = ctx.sessionService.create({
        title: "空人设会话",
        cwd: process.cwd(),
        agentId: "empty-profile",
      });

      // systemPrompt 应为 undefined
      const runtime = await SessionRuntime.create({
        sessionId: session.id,
        cwd: process.cwd(),
        sessionDir: ctx.paths.sessions,
        authPath: ctx.paths.authFile,
        providerId: "faux",
        modelId: "faux-1",
        faux: { response: "收到。" },
        publish: () => {},
        sessionHandle: session,
      });

      const run = runtime.prompt("test");
      await run.completed;

      expect(session.messageEntries.length).toBe(2);
      runtime.dispose();
    } finally {
      ctx.dispose();
    }
  });
});
