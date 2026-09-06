import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];

function createContext(existingPaths?: ReturnType<typeof getRuntimePaths>) {
  const directory = existingPaths
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-session-"));
  if (directory) temporaryDirectories.push(directory);
  const paths = existingPaths ?? getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const service = new SessionService(paths, index);
  return { paths, database, index, service };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("session lifecycle", () => {
  it("creates, opens, and continues a persisted PI JSONL session", async () => {
    const first = createContext();
    const created = first.service.create({ title: "可恢复会话", cwd: process.cwd() });
    created.appendUserMessage("第一条消息");
    created.selectModel("faux", "faux-1");
    created.appendAssistantMessage("第一条回复");
    const sessionPath = created.path;
    first.service.closeAll();
    first.database.close();

    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(fs.readFileSync(sessionPath, "utf8")).not.toContain("apiKey");

    const second = createContext(first.paths);
    const reopened = second.service.open(created.id);
    expect(reopened.id).toBe(created.id);
    expect(reopened.path).toBe(sessionPath);
    expect(reopened.messages).toEqual(["第一条消息", "第一条回复"]);
    expect(reopened.model).toEqual({ providerId: "faux", modelId: "faux-1" });

    const continued = second.service.continue(created.id);
    continued.appendUserMessage("继续消息");
    expect(second.service.open(created.id).messages).toContain("继续消息");
    second.service.closeAll();
    second.database.close();
  });

  it("persists a newly created empty session across a restart", () => {
    const first = createContext();
    const created = first.service.create({ title: "尚未开始", cwd: process.cwd() });
    expect(fs.existsSync(created.path)).toBe(true);
    first.service.closeAll();
    first.database.close();

    const second = createContext(first.paths);
    expect(second.service.list()).toHaveLength(1);
    expect(second.service.getView(created.id).messageEntries).toEqual([]);
    second.service.closeAll();
    second.database.close();
  });

  it("keeps one authoritative runtime and archives through the HTTP route", async () => {
    const context = createContext();
    const created = context.service.create({ title: "唯一运行态", cwd: process.cwd() });
    expect(context.service.open(created.id)).toBe(created);

    const { app } = createTrustedServerApp({ sessionService: context.service });
    expect((await (await app.request("http://127.0.0.1/api/sessions")).json() as unknown[]).length).toBe(1);

    const archiveResponse = await app.request(`http://127.0.0.1/api/sessions/${created.id}`, {
      method: "DELETE",
    });
    expect(archiveResponse.status).toBe(200);
    expect((await app.request(`http://127.0.0.1/api/sessions/${created.id}`)).status).toBe(200);
    expect(await (await app.request("http://127.0.0.1/api/sessions")).json()).toEqual([]);

    // includeArchived 可见已归档会话
    const withArchived = await (await app.request("http://127.0.0.1/api/sessions?includeArchived=true")).json() as { archived: boolean }[];
    expect(withArchived).toHaveLength(1);
    expect(withArchived[0]!.archived).toBe(true);

    // unarchive 恢复会话
    const unarchiveResponse = await app.request(`http://127.0.0.1/api/sessions/${created.id}/unarchive`, {
      method: "POST",
    });
    expect(unarchiveResponse.status).toBe(200);
    const restored = await unarchiveResponse.json() as { archived: boolean };
    expect(restored.archived).toBe(false);
    expect((await (await app.request("http://127.0.0.1/api/sessions")).json() as unknown[]).length).toBe(1);

    context.service.closeAll();
    context.database.close();
  });

  it("keeps SessionView current while Runtime writes through the same session handle", async () => {
    const context = createContext();
    const created = context.service.create({ title: "运行中会话", cwd: process.cwd() });
    const runtime = await SessionRuntime.create({
      sessionId: created.id,
      cwd: process.cwd(),
      sessionDir: context.paths.sessions,
      authPath: context.paths.authFile,
      providerId: "faux",
      modelId: "faux-1",
      faux: { response: "运行时回复" },
      publish: () => {},
      replayStore: new EventReplayStore(),
      sessionHandle: created,
    });

    try {
      const run = runtime.prompt("运行时消息");
      await run.completed;

      expect(context.service.getView(created.id).messages).toEqual([
        "运行时消息",
        "运行时回复",
      ]);
    } finally {
      runtime.dispose();
      context.service.closeAll();
      context.database.close();
    }
  });

  it("rejects path traversal and missing sessions", () => {
    const context = createContext();
    expect(() => context.service.open("../outside")).toThrow();
    expect(() => context.service.open("missing-session")).toThrow();
    context.database.close();
  });

  it("skips and removes orphaned index rows instead of failing the whole session list", () => {
    const context = createContext();
    const valid = context.service.create({ title: "有效会话", cwd: process.cwd() });
    const orphanId = "00000000-0000-4000-8000-000000000001";
    context.index.create({
      id: orphanId,
      title: "孤儿会话",
      sessionPath: path.join(context.paths.sessions, "missing-session.jsonl"),
      workspaceCwd: process.cwd(),
    });

    const listed = context.service.list({ includeArchived: true });
    expect(listed.map((session) => session.id)).toEqual([valid.id]);
    expect(context.index.get(orphanId)).toBeUndefined();

    context.service.closeAll();
    context.database.close();
  });
});
