import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { createServerApp } from "../../src/server/app.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { parseSessionSettings } from "../../src/contracts/session-settings.js";
import { ToolPolicy } from "../../src/runtime/tool-policy.js";
import type { ModelService } from "../../src/runtime/model-service.js";
import { instrument } from "../../src/observability/instrument.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-settings-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const service = new SessionService(paths, index);
  return { paths, database, index, service };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("session settings", () => {
  it("creates session with a read-only default bound to the session cwd", () => {
    const ctx = createContext();
    const session = ctx.service.create({ title: "默认设置", cwd: process.cwd() });
    const view = ctx.service.getView(session.id);
    expect(view.toolMode).toBe("read-only");
    expect(view.workspaceCwd).toBe(process.cwd());
    expect(view.workspaceConfirmed).toBe(false);
    expect(view.thinkingLevel).toBe("medium");
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("persists and recovers toolMode via updateSettings", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });

    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "工具会话", cwd: process.cwd() }),
    });
    expect(createResp.status).toBe(201);
    const session = (await createResp.json()) as { id: string };

    // 设置 read-only
    const updateResp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "read-only" }),
      },
    );
    expect(updateResp.status).toBe(200);
    const updated = (await updateResp.json()) as { toolMode: string };
    expect(updated.toolMode).toBe("read-only");

    // 验证重启后能读到（同一 SessionService 实例）
    const view = ctx.service.getView(session.id);
    expect(view.toolMode).toBe("read-only");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("creates session in all mode without confirmation and runtime degrades to read-only", async () => {
    const ctx = createContext();
    const promptService = new PromptService();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      promptService,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "未确认 all", cwd: process.cwd(), toolMode: "all" }),
    });
    expect(createResp.status).toBe(201);
    const session = (await createResp.json()) as { id: string; toolMode: string; workspaceConfirmed: boolean; workspaceCwd: string };
    expect(session.toolMode).toBe("all");
    expect(session.workspaceConfirmed).toBe(false);

    const policy = new ToolPolicy();
    expect(policy.resolveTools("all", session.workspaceCwd, false)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);

    promptService.dispose();
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("confirms all mode and exposes full tools after invalidating runtime", async () => {
    const ctx = createContext();
    const promptService = new PromptService();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      promptService,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待确认", cwd: process.cwd(), toolMode: "all" }),
    });
    const session = (await createResp.json()) as { id: string; workspaceCwd: string };

    // 建立一次 runtime，使其在确认后被 invalidate
    const runtime = await SessionRuntime.create({
      sessionId: session.id,
      cwd: session.workspaceCwd,
      sessionDir: ctx.paths.sessions,
      authPath: ctx.paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "ok" },
      publish: () => {},
      sessionHandle: ctx.service.open(session.id),
    });
    promptService.register(runtime);

    const resp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceConfirmed: true }),
      },
    );
    expect(resp.status).toBe(200);
    const updated = (await resp.json()) as { workspaceConfirmed: boolean; toolMode: string };
    expect(updated.workspaceConfirmed).toBe(true);
    expect(updated.toolMode).toBe("all");

    // invalidate 后再次解析应拿到完整工具集
    expect(promptService.hasRuntime(session.id)).toBe(false);
    const policy = new ToolPolicy();
    expect(policy.resolveTools("all", session.workspaceCwd, true)).toContain("write");
    expect(policy.resolveTools("all", session.workspaceCwd, true)).toContain("bash");

    promptService.dispose();
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("accepts all mode with cwd and workspaceConfirmed", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "已确认", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    const resp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolMode: "all",
          workspaceCwd: process.cwd(),
          workspaceConfirmed: true,
        }),
      },
    );
    expect(resp.status).toBe(200);
    const updated = (await resp.json()) as { toolMode: string; workspaceConfirmed: boolean };
    expect(updated.toolMode).toBe("all");
    expect(updated.workspaceConfirmed).toBe(true);

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("allows switching from read-only to all without reconfirmation and degrades tools", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "切换 all", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string; workspaceCwd: string };

    const resp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "all" }),
      },
    );
    expect(resp.status).toBe(200);
    const updated = (await resp.json()) as { toolMode: string; workspaceConfirmed: boolean };
    expect(updated.toolMode).toBe("all");
    expect(updated.workspaceConfirmed).toBe(false);

    const policy = new ToolPolicy();
    expect(policy.resolveTools("all", session.workspaceCwd, false)).not.toContain("write");
    expect(policy.resolveTools("all", session.workspaceCwd, false)).not.toContain("bash");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("requires reconfirmation when an all-mode workspace changes", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "工作区变更",
        cwd: process.cwd(),
        toolMode: "all",
        workspaceCwd: process.cwd(),
        workspaceConfirmed: true,
      }),
    });
    const session = (await createResp.json()) as { id: string };

    const response = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceCwd: os.tmpdir() }),
      },
    );

    expect(response.status).toBe(400);
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("allows a read-only workspace change without write confirmation", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "只读工作区", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    const response = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "read-only", workspaceCwd: os.tmpdir() }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      toolMode: "read-only",
      workspaceCwd: os.tmpdir(),
      workspaceConfirmed: false,
    });
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("rejects path traversal in cwd", () => {
    expect(() => parseSessionSettings({
      toolMode: "all",
      cwd: "/etc/../passwd",
      workspaceConfirmed: true,
    })).toThrow("..");
  });

  it("rejects unknown tool mode", () => {
    expect(() => parseSessionSettings({ toolMode: "unsafe" })).toThrow();
  });

  it("persists a valid thinking level and rejects an unknown level", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "思考级别", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    const updateResp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "high" }),
      },
    );
    expect(updateResp.status).toBe(200);
    expect(await updateResp.json()).toMatchObject({ thinkingLevel: "high" });

    const invalidResp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "extreme" }),
      },
    );
    expect(invalidResp.status).toBe(400);
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("disposes an idle runtime when settings change", async () => {
    const ctx = createContext();
    const promptService = new PromptService();
    const session = ctx.service.create({ title: "运行时重建", cwd: process.cwd() });
    const runtime = await SessionRuntime.create({
      sessionId: session.id,
      cwd: process.cwd(),
      sessionDir: ctx.paths.sessions,
      authPath: ctx.paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "ok" },
      publish: () => {},
      sessionHandle: session,
    });
    promptService.register(runtime);
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      promptService,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),    });

    const response = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "read-only" }),
      },
    );

    expect(response.status).toBe(200);
    expect(promptService.hasRuntime(session.id)).toBe(false);
    promptService.dispose();
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("archived session settings are preserved but session is not listed", async () => {
    const ctx = createContext();
    const promptService = new PromptService();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      promptService,
      paths: ctx.paths,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待归档", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "read-only" }),
      },
    );

    const delResp = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}`,
      { method: "DELETE" },
    );
    expect(delResp.status).toBe(200);

    // 归档后默认列表不包含
    const list = (await (await app.request("http://127.0.0.1/api/sessions")).json()) as unknown[];
    expect(list.length).toBe(0);

    const promptResponse = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "不应执行" }),
      },
    );
    expect(promptResponse.status).toBe(409);

    promptService.dispose();
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("rejects directory switch without re-confirmation in all mode", async () => {
    const ctx = createContext();
    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "目录切换", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    // Step 1: 设为 all + 确认目录 A
    const r1 = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolMode: "all",
          workspaceCwd: process.cwd(),
          workspaceConfirmed: true,
        }),
      },
    );
    expect(r1.status).toBe(200);

    // Step 2: 切换到目录 B 但不重新确认 → 应拒绝
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "switched-"));
    temporaryDirectories.push(tmpDir);
    const r2 = await app.request(
      `http://127.0.0.1/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolMode: "all",
          workspaceCwd: tmpDir,
        }),
      },
    );
    expect(r2.status).toBe(400);

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("applies global defaults only when creating a new session", async () => {
    const ctx = createContext();
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);
    // 修改全局默认：thinkingLevel=high, toolMode=off
    preferencesStore.update({
      defaults: { thinkingLevel: "high", toolMode: "off", model: null } as never,
    });

    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      preferencesStore,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),    });
    const createResp = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "应用默认", cwd: process.cwd() }),
    });
    expect(createResp.status).toBe(201);
    const view = (await createResp.json()) as {
      thinkingLevel: string;
      toolMode: string;
    };
    // 全局默认应被应用到新会话
    expect(view.thinkingLevel).toBe("high");
    expect(view.toolMode).toBe("off");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("binds the canonical primary selection when a default model is available", async () => {
    const ctx = createContext();
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);
    preferencesStore.update({
      defaults: { thinkingLevel: "medium", toolMode: "read-only", model: { providerId: "faux", modelId: "faux-1" } } as never,
    });
    const modelService = {
      listProviders: () => [{ providerId: "faux", credentialConfigured: true }],
      resolveModel: (providerId: string, modelId: string) => ({ providerId, modelId }),
    } as unknown as ModelService;

    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      modelService,
      preferencesStore,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),
    });
    const response = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "默认模型", cwd: process.cwd() }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()) as { model: unknown }).toMatchObject({
      model: { providerId: "faux", modelId: "faux-1" },
    });

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("keeps the session unbound and diagnoses an unavailable default model", async () => {
    const ctx = createContext();
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);
    preferencesStore.update({
      defaults: { thinkingLevel: "medium", toolMode: "read-only", model: { providerId: "faux", modelId: "faux-1" } } as never,
    });
    const modelService = {
      listProviders: () => [{ providerId: "faux", credentialConfigured: false }],
      resolveModel: () => {
        throw new Error("resolver should not be called when credentials are absent");
      },
    } as unknown as ModelService;
    const warnSpy = vi.spyOn(instrument, "warn").mockImplementation(() => {});

    try {
      const { app } = createTrustedServerApp({
        sessionService: ctx.service,
        modelService,
        preferencesStore,
        audit: new AuditRecorder({
          database: ctx.database,
          producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
        }),
      });
      const response = await app.request("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "不可用默认模型", cwd: process.cwd() }),
      });

      expect(response.status).toBe(201);
      expect((await response.json()) as { model: unknown }).toMatchObject({ model: null });
      expect(warnSpy).toHaveBeenCalledWith(
        "session.model.default_selection_failed",
        "创建会话时未绑定主对话默认模型",
        expect.objectContaining({
          reasonCode: "model_no_credentials",
          reason: expect.stringContaining("未配置凭据"),
          role: "primary",
          source: "user_default",
        }),
      );
    } finally {
      warnSpy.mockRestore();
      ctx.service.closeAll();
      ctx.database.close();
    }
  });

  it("keeps an existing session override after global defaults change", async () => {
    const ctx = createContext();
    const preferencesStore = new PreferencesStore(ctx.paths.preferences);

    const { app } = createTrustedServerApp({
      sessionService: ctx.service,
      preferencesStore,
      audit: new AuditRecorder({
        database: ctx.database,
        producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
      }),    });

    // 创建一个 session 并显式设置 thinkingLevel=low
    const created = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "显式覆盖",
        cwd: process.cwd(),
        thinkingLevel: "low",
      }),
    });
    const session = (await created.json()) as { id: string };

    // 先确认创建时已写入显式 thinkingLevel=low
    const initialResp = await app.request(`http://127.0.0.1/api/sessions/${session.id}`);
    const initialView = (await initialResp.json()) as { thinkingLevel: string };
    expect(initialView.thinkingLevel).toBe("low");

    // 修改全局默认 thinkingLevel=max
    preferencesStore.update({
      defaults: { thinkingLevel: "max", toolMode: "read-only", model: null } as never,
    });

    // 重新读取现有 session：显式值 low 应保留
    const getResp = await app.request(`http://127.0.0.1/api/sessions/${session.id}`);
    const view = (await getResp.json()) as { thinkingLevel: string };
    expect(view.thinkingLevel).toBe("low");

    ctx.service.closeAll();
    ctx.database.close();
  });
});
