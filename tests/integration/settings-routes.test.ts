import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { createServerApp } from "../../src/server/app.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";

const temporaryDirectories: string[] = [];

function createPaths() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-settings-routes-"));
  temporaryDirectories.push(directory);
  return getRuntimePaths({ OPENCOLORFUL_HOME: directory });
}

function providerInput() {
  return {
    providerId: "local-openai",
    name: "Local OpenAI",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: {},
    models: [
      {
        modelId: "local-model",
        name: "Local Model",
        capabilities: {
          reasoning: false,
          input: ["text"],
          contextWindow: 32_768,
          maxTokens: 4_096,
        },
      },
    ],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

async function createContext() {
  const paths = createPaths();
  const database = openMetadataDatabase(paths.database);
  // 评审 P0（第三轮）：凭据变更属 fail-closed——测试提供真实审计
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
  });
  const modelService = await ModelService.create(paths, new ProviderStore(paths.providerSettings), audit);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const preferencesStore = new PreferencesStore(paths.preferences);
  return { paths, modelService, database, sessionService, preferencesStore };
}

describe("preferences routes", () => {
  it("GET /api/settings/preferences returns defaults and layout", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const resp = await app.request("http://local/api/settings/preferences");
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { version: number; layout: Record<string, unknown> };
      expect(body.version).toBe(2);
      expect(body.layout).toMatchObject({
        leftSidebarWidth: expect.any(Number),
        rightSidebarWidth: expect.any(Number),
        leftCollapsed: false,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "system",
      });
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("PUT /api/settings/preferences updates layout and re-reads it", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const resp = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: { leftSidebarWidth: 360, focusMode: true } }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { layout: { leftSidebarWidth: number; focusMode: boolean } };
      expect(body.layout.leftSidebarWidth).toBe(360);
      expect(body.layout.focusMode).toBe(true);

      // 新 store 实例从磁盘复读应得到持久化的值
      const reopened = new PreferencesStore(ctx.paths.preferences);
      expect(reopened.get().layout.leftSidebarWidth).toBe(360);
      expect(reopened.get().layout.focusMode).toBe(true);
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("PUT /api/settings/preferences validates tool mode", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const resp = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { toolMode: "danger" } }),
      });
      expect(resp.status).toBe(400);

      // 之前的默认文档不应被改写
      expect(ctx.preferencesStore.get().defaults.toolMode).toBe("read-only");
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("rejects all as a global default because workspace confirmation is session-scoped", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const resp = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { toolMode: "all" } }),
      });

      expect(resp.status).toBe(400);
      expect(ctx.preferencesStore.get().defaults.toolMode).toBe("read-only");
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("rejects an unavailable default model without changing the previous document", async () => {
    const ctx = await createContext();
    try {
      // 先写入一个合法默认
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const ok = await app.request("http://local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerInput(), apiKey: "secret" }),
      });
      expect(ok.status).toBe(200);

      const setDefault = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { model: { providerId: "local-openai", modelId: "local-model" } },
        }),
      });
      expect(setDefault.status).toBe(200);

      // 然后尝试写入一个不存在的模型引用 → 应该 400 且不修改文档
      const bad = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { model: { providerId: "local-openai", modelId: "ghost-model" } },
        }),
      });
      expect(bad.status).toBe(400);
      expect(ctx.preferencesStore.get().defaults.model).toEqual({
        providerId: "local-openai",
        modelId: "local-model",
      });
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("PUT subagents.defaultModel persists through route → file → reopen", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      const ok = await app.request("http://local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerInput(), apiKey: "secret" }),
      });
      expect(ok.status).toBe(200);

      const resp = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subagents: { defaultModel: { providerId: "local-openai", modelId: "local-model" } },
        }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        subagents?: { defaultModel: { providerId: string; modelId: string } | null };
      };
      expect(body.subagents?.defaultModel).toEqual({
        providerId: "local-openai",
        modelId: "local-model",
      });

      // 无关 section 的后续写入不得丢弃 subagents（路由 merge + store update 全链路）
      const unrelated = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: { focusMode: true } }),
      });
      expect(unrelated.status).toBe(200);

      // 新 store 实例从磁盘复读应得到持久化的 subagents 值
      const reopened = new PreferencesStore(ctx.paths.preferences);
      expect(reopened.get().subagents?.defaultModel).toEqual({
        providerId: "local-openai",
        modelId: "local-model",
      });
      expect(reopened.get().layout.focusMode).toBe(true);
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("PUT /api/settings/preferences persists showToolCalls and showThinking", async () => {
    const ctx = await createContext();
    try {
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });

      // 写入新的 appearance 值
      const resp = await app.request("http://local/api/settings/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appearance: { showToolCalls: false, showThinking: false },
        }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { appearance: { showToolCalls: boolean; showThinking: boolean; theme: string } };
      expect(body.appearance.showToolCalls).toBe(false);
      expect(body.appearance.showThinking).toBe(false);
      // 未修改的 theme 保留原值
      expect(body.appearance.theme).toBe("dark");

      // 新 store 从磁盘复读得到持久化的值
      const reopened = new PreferencesStore(ctx.paths.preferences);
      expect(reopened.get().appearance.showToolCalls).toBe(false);
      expect(reopened.get().appearance.showThinking).toBe(false);
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });

  it("does not expose credentials in the preferences response", async () => {
    const ctx = await createContext();
    try {
      // 写入一个 Provider + API key
      const { app } = createServerApp({
        modelService: ctx.modelService,
        sessionService: ctx.sessionService,
        preferencesStore: ctx.preferencesStore,
      });
      await app.request("http://local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerInput(), apiKey: "super-secret-key" }),
      });

      const resp = await app.request("http://local/api/settings/preferences");
      const text = await resp.text();
      expect(text).not.toContain("super-secret-key");
      expect(text).not.toContain("apiKey");
    } finally {
      ctx.sessionService.closeAll();
      ctx.database.close();
    }
  });
});
