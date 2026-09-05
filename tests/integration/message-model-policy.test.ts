import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("messages route model policy", () => {
  it("rejects an unbound production session instead of creating a faux runtime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-message-model-policy-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    const database = openMetadataDatabase(paths.database);
    const sessionService = new SessionService(paths, new SessionIndex(database));
    const promptService = new PromptService();
    const modelService = {
      listProviders: () => [{ providerId: "configured", credentialConfigured: true }],
      resolveModel: () => { throw new Error("must not resolve a model"); },
    };
    const { app } = createServerApp({
      paths,
      database,
      sessionService,
      promptService,
      replayStore: new EventReplayStore(),
      modelService: modelService as never,
    });
    const session = sessionService.create({ title: "未选模型", cwd: process.cwd() });

    try {
      const response = await app.request(`http://local/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "不得静默使用 faux" }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "CONFLICT",
        message: "当前 Session 未选择主对话模型，请先配置默认模型或显式选择模型",
      });
      expect(promptService.hasRuntime(session.id)).toBe(false);
    } finally {
      promptService.dispose();
      sessionService.closeAll();
      database.close();
    }
  });
});
