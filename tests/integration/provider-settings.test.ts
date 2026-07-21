import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { parseProviderInput } from "../../src/contracts/provider-settings.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];
const API_KEY = "integration-secret-key";

function createPaths() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-provider-"));
  temporaryDirectories.push(directory);
  return getRuntimePaths({ PERSON_AGENT_HOME: directory });
}

function providerInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "local-openai",
    name: "Local OpenAI",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: { "X-Workspace": "person-agent" },
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
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider settings", () => {
  it("persists provider settings and PI credentials separately", async () => {
    const paths = createPaths();
    const firstService = await ModelService.create(paths, new ProviderStore(paths.providerSettings));
    const firstApp = createServerApp({ modelService: firstService });

    const putResponse = await firstApp.request("http://local/api/settings/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerInput(), apiKey: API_KEY }),
    });
    expect(putResponse.status).toBe(200);
    const putBody = await putResponse.text();
    expect(putBody).not.toContain(API_KEY);
    expect(JSON.parse(putBody)).toMatchObject({
      providerId: "local-openai",
      credentialConfigured: true,
      credentialRef: "provider:local-openai",
    });

    const settingsJson = fs.readFileSync(paths.providerSettings, "utf8");
    expect(settingsJson).not.toContain(API_KEY);
    expect(settingsJson).toContain("provider:local-openai");
    expect(fs.readFileSync(paths.authFile, "utf8")).toContain(API_KEY);

    const reopenedService = await ModelService.create(paths, new ProviderStore(paths.providerSettings));
    const reopenedApp = createServerApp({ modelService: reopenedService });
    const providers = await (await reopenedApp.request("http://local/api/settings/providers")).json();
    expect(providers).toEqual([
      expect.objectContaining({ providerId: "local-openai", credentialConfigured: true }),
    ]);

    const models = await (await reopenedApp.request("http://local/api/models")).json();
    expect(models).toEqual([
      expect.objectContaining({
        providerId: "local-openai",
        modelId: "local-model",
        protocol: "openai-completions",
      }),
    ]);
  });

  it.each([
    ["invalid URL", providerInput({ baseUrl: "file:///tmp/model" })],
    ["unknown protocol", providerInput({ protocol: "custom-unsafe" })],
    [
      "duplicate models",
      providerInput({
        models: [
          providerInput().models[0],
          { ...providerInput().models[0], name: "Duplicate" },
        ],
      }),
    ],
    ["secret header", providerInput({ headers: { Authorization: `Bearer ${API_KEY}` } })],
  ])("rejects %s without leaking submitted secrets", async (_name, provider) => {
    const paths = createPaths();
    const service = await ModelService.create(paths, new ProviderStore(paths.providerSettings));
    const app = createServerApp({ modelService: service });

    const response = await app.request("http://local/api/settings/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, apiKey: API_KEY }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(API_KEY);
  });

  it("uses PI environment fallback only when no provider settings exist", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "development-only-key";
    try {
      const paths = createPaths();
      const emptyStore = new ProviderStore(paths.providerSettings);
      const fallbackService = await ModelService.create(paths, emptyStore);
      expect(fallbackService.listModels()).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: "openai" })]),
      );

      emptyStore.upsert(parseProviderInput(providerInput()));
      const configuredService = await ModelService.create(paths, emptyStore);
      expect(configuredService.listModels()).toEqual([
        expect.objectContaining({ providerId: "local-openai", modelId: "local-model" }),
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});
