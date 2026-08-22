import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-rename-"));
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

describe("session rename", () => {
  it("renames an active session and updates both index and JSONL", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const created = ctx.service.create({ title: "旧标题", cwd: process.cwd() });

    const resp = await app.request(`http://local/api/sessions/${created.id}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  新标题  " }),
    });
    expect(resp.status).toBe(200);
    const updated = (await resp.json()) as { title: string };
    expect(updated.title).toBe("新标题");

    // 索引
    expect(ctx.service.getView(created.id).title).toBe("新标题");
    // JSONL（关闭后从文件内容验证持久化标题）
    ctx.service.closeAll();
    const content = fs.readFileSync(created.path, "utf8");
    expect(content).toContain("新标题");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("renames an inactive session without booting a full runtime", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const created = ctx.service.create({ title: "未激活", cwd: process.cwd() });
    const sessionPath = created.path;
    ctx.service.closeAll();

    const resp = await app.request(`http://local/api/sessions/${created.id}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "已改名" }),
    });
    expect(resp.status).toBe(200);

    // 索引
    expect(ctx.service.getView(created.id).title).toBe("已改名");
    // JSONL 文件内容包含 session info 标题
    const content = fs.readFileSync(sessionPath, "utf8");
    expect(content).toContain("已改名");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("rejects empty title", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const created = ctx.service.create({ title: "有标题", cwd: process.cwd() });

    const resp = await app.request(`http://local/api/sessions/${created.id}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("INVALID_INPUT");

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("returns 404 for non-existent session", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });

    const resp = await app.request(`http://local/api/sessions/${crypto.randomUUID()}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(resp.status).toBe(404);

    ctx.service.closeAll();
    ctx.database.close();
  });

  it("allows renaming an archived session", async () => {
    const ctx = createContext();
    const { app } = createServerApp({ sessionService: ctx.service });
    const created = ctx.service.create({ title: "归档前", cwd: process.cwd() });

    await app.request(`http://local/api/sessions/${created.id}`, { method: "DELETE" });

    const resp = await app.request(`http://local/api/sessions/${created.id}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "归档后" }),
    });
    expect(resp.status).toBe(200);
    const updated = (await resp.json()) as { title: string; archived: boolean };
    expect(updated.title).toBe("归档后");
    expect(updated.archived).toBe(true);

    ctx.service.closeAll();
    ctx.database.close();
  });
});
