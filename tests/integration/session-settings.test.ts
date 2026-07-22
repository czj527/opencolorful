import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { createServerApp } from "../../src/server/app.js";
import { parseSessionSettings } from "../../src/contracts/session-settings.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-settings-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
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
  it("creates session with default toolMode off", () => {
    const ctx = createContext();
    const session = ctx.service.create({ title: "默认设置", cwd: process.cwd() });
    const view = ctx.service.getView(session.id);
    expect(view.toolMode).toBe("off");
    expect(view.workspaceConfirmed).toBe(false);
    ctx.service.closeAll();
    ctx.database.close();
  });

  it("persists and recovers toolMode via updateSettings", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });

    const createResp = await app.request("http://local/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "工具会话", cwd: process.cwd() }),
    });
    expect(createResp.status).toBe(201);
    const session = (await createResp.json()) as { id: string };

    // 设置 read-only
    const updateResp = await app.request(
      `http://local/api/sessions/${session.id}/settings`,
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

  it("rejects all mode without workspace confirmation", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const createResp = await app.request("http://local/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "未确认", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    const resp = await app.request(
      `http://local/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "all" }),
      },
    );
    expect(resp.status).toBe(400);

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("accepts all mode with cwd and workspaceConfirmed", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const createResp = await app.request("http://local/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "已确认", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    const resp = await app.request(
      `http://local/api/sessions/${session.id}/settings`,
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

  it("archived session settings are preserved but session is not listed", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const createResp = await app.request("http://local/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待归档", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    await app.request(
      `http://local/api/sessions/${session.id}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolMode: "read-only" }),
      },
    );

    const delResp = await app.request(
      `http://local/api/sessions/${session.id}`,
      { method: "DELETE" },
    );
    expect(delResp.status).toBe(200);

    // 归档后默认列表不包含
    const list = (await (await app.request("http://local/api/sessions")).json()) as unknown[];
    expect(list.length).toBe(0);

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("rejects directory switch without re-confirmation in all mode", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const createResp = await app.request("http://local/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "目录切换", cwd: process.cwd() }),
    });
    const session = (await createResp.json()) as { id: string };

    // Step 1: 设为 all + 确认目录 A
    const r1 = await app.request(
      `http://local/api/sessions/${session.id}/settings`,
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
      `http://local/api/sessions/${session.id}/settings`,
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
});
