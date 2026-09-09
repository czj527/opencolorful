import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { parseProviderInput } from "../../src/contracts/provider-settings.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { createServerApp } from "../../src/server/app.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];
const API_KEY = "integration-secret-key";

function createPaths() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-provider-"));
  temporaryDirectories.push(directory);
  return getRuntimePaths({ OPENCOLORFUL_HOME: directory });
}

// 评审 P0（第三轮）：凭据变更属 fail-closed——测试提供真实审计（挂同一 metadata DB）
function makeAudit(paths: ReturnType<typeof getRuntimePaths>) {
  const database = openMetadataDatabase(paths.database);
  temporaryDirectories.push(paths.home);
  return {
    audit: new AuditRecorder({
      database,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
    }),
    close: () => database.close(),
  };
}

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

describe("provider settings", () => {
  it("persists provider settings and PI credentials separately", async () => {
    const paths = createPaths();
    const { audit: firstAudit, close: closeFirst } = makeAudit(paths);
    const firstService = await ModelService.create(paths, new ProviderStore(paths.providerSettings), firstAudit);
    const { app: firstApp } = createTrustedServerApp({ modelService: firstService });

    const putResponse = await firstApp.request("http://127.0.0.1/api/settings/providers", {
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
    closeFirst();

    const settingsJson = fs.readFileSync(paths.providerSettings, "utf8");
    expect(settingsJson).not.toContain(API_KEY);
    expect(settingsJson).toContain("provider:local-openai");
    expect(fs.readFileSync(paths.authFile, "utf8")).toContain(API_KEY);

    const { audit: reopenedAudit, close: closeReopened } = makeAudit(paths);
    const reopenedService = await ModelService.create(paths, new ProviderStore(paths.providerSettings), reopenedAudit);
    const { app: reopenedApp } = createTrustedServerApp({ modelService: reopenedService });
    const providers = await (await reopenedApp.request("http://127.0.0.1/api/settings/providers")).json();
    expect(providers).toEqual([
      expect.objectContaining({ providerId: "local-openai", credentialConfigured: true }),
    ]);
    closeReopened();

    const models = await (await reopenedApp.request("http://127.0.0.1/api/models")).json();
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
    const { app } = createTrustedServerApp({ modelService: service });

    const response = await app.request("http://127.0.0.1/api/settings/providers", {
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

  // 发布验证发现（2026-09-09）：自定义代理站常与 OpenAI 新式默认不兼容
  // （developer 角色 / reasoning_effort 取值），model.compat 必须从契约一路
  // 透传到 pi-ai 注册链，否则自定义 Provider 无法声明站点兼容性。
  it("persists model compat overrides and passes them through to the PI runtime", async () => {
    const paths = createPaths();
    const compat = {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    };
    const withCompat = providerInput({
      models: [{ ...providerInput().models[0], compat }],
    });

    // 契约层：合法 compat 通过解析并原样保留
    const parsed = parseProviderInput(withCompat);
    expect(parsed.models[0].compat).toEqual(compat);

    // 注册链：经 ModelService.upsert（含凭据）后，resolveModel 返回的模型携带
    // compat（PI SDK 据此覆盖请求形状）
    const { audit, close } = makeAudit(paths);
    const service = await ModelService.create(paths, new ProviderStore(paths.providerSettings), audit);
    await service.upsert(parsed, API_KEY);
    const resolved = service.resolveModel("local-openai", "local-model") as unknown as {
      model?: { compat?: Record<string, unknown> };
    };
    expect(resolved.model?.compat).toMatchObject(compat);

    // 持久化层：compat 落盘 providers.json 并在重开后保留
    const reread = new ProviderStore(paths.providerSettings).list();
    expect(reread[0].models[0].compat).toEqual(compat);
    close();
  });

  it("rejects unknown compat fields and values", () => {
    // 白名单外字段拒绝（additionalProperties: false）
    expect(() =>
      parseProviderInput(
        providerInput({
          models: [{ ...providerInput().models[0], compat: { supportsStore: true, evilField: true } }],
        }),
      ),
    ).toThrow();
    // 越界取值拒绝
    expect(() =>
      parseProviderInput(
        providerInput({
          models: [{ ...providerInput().models[0], compat: { maxTokensField: "unlimited" } }],
        }),
      ),
    ).toThrow();
    // 无 compat 的既有配置仍正常解析（向后兼容）
    expect(parseProviderInput(providerInput()).models[0].compat).toBeUndefined();
  });
});
