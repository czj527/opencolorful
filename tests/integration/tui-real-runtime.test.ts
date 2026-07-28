import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { startForegroundServer } from "../../src/server/start.js";
import { TuiApiClient } from "../../src/tui/api-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("TUI real runtime", () => {
  it("lists providers via TuiApiClient", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-tui-real-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    const replayStore = new EventReplayStore();
    const promptService = new PromptService();
    const database = openMetadataDatabase(paths.database);
    const index = new SessionIndex(database);
    const sessionService = new SessionService(paths, index);
    const providerStore = new ProviderStore(paths.providerSettings);
    const modelService = await ModelService.create(paths, providerStore);

    const server = await startForegroundServer({
      host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION,
      appOptions: { promptService, replayStore, sessionService, modelService },
    });

    try {
      const api = new TuiApiClient(`http://127.0.0.1:${server.port}`);

      // 配置一个 Provider
      const putResp = await fetch(
        `http://127.0.0.1:${server.port}/api/settings/providers`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: {
              providerId: "tui-test",
              name: "TUI Test",
              protocol: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              models: [{
                modelId: "test-model",
                name: "Test Model",
                capabilities: { reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
              }],
            },
            apiKey: "test-key",
          }),
        },
      );
      expect(putResp.status).toBe(200);

      const providers = await api.listProviders();
      expect(providers.length).toBeGreaterThan(0);
      expect(providers[0]).toMatchObject({ providerId: "tui-test" });

      // 更新 session 设置
      const session = await api.createSession("TUI 设置测试", process.cwd());
      await expect(
        api.setSessionModel(session.id, "tui-test", "missing-model"),
      ).rejects.toThrow("模型");
      const selected = await api.setSessionModel(session.id, "tui-test", "test-model");
      expect(selected.model).toEqual({ providerId: "tui-test", modelId: "test-model" });
      const updated = await api.updateSessionSettings(session.id, { toolMode: "read-only" });
      expect(updated.toolMode).toBe("read-only");

      sessionService.closeAll();
    } finally {
      await server.stop();
      database.close();
    }
  });
});
