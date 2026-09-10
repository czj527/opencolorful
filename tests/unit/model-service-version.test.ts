import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { parseProviderInput } from "../../src/contracts/provider-settings.js";
import { ModelService } from "../../src/runtime/model-service.js";

const temporaryDirectories: string[] = [];

function providerInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "local-openai",
    name: "Local OpenAI",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: { "X-Workspace": "opencolorful" },
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

describe("ModelService configVersion", () => {
  it("starts at 0, increments once per successful upsert", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-model-service-version-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    const service = await ModelService.create(paths, new ProviderStore(paths.providerSettings));

    expect(service.configVersion).toBe(0);

    await service.upsert(parseProviderInput(providerInput()));
    expect(service.configVersion).toBe(1);

    await service.upsert(parseProviderInput(providerInput({ baseUrl: "http://127.0.0.1:11500/v1" })));
    expect(service.configVersion).toBe(2);
  });
});
