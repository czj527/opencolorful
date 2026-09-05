/**
 * A4d lane 本地 fixture：隔离 home 内的前置数据准备（API 直连，不经 UI）。
 *
 * 目的：把"建助理"从 UI 链路里解耦出来，让 MEM-05 用例聚焦维护条 SSE 实时链路。
 * 数据仍落在本用例的临时 OPENCOLORFUL_HOME；不经引导（引导链路由 A4a 覆盖）。
 */
import { expect } from "@playwright/test";

import type { BackendHarness } from "../backend.js";
import { apiSend, type AgentViewWire } from "./api.js";

export interface CreatedAgent {
  readonly id: string;
  readonly name: string;
}

export interface StubProviderInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
}

/**
 * PUT /api/settings/providers：注册指向本地 stub 的自定义 Provider（凭据入 AuthStorage）。
 * 用例并不调用模型（deep-dive 默认 script 模式零 LLM），但 App 首启检测
 * （use-first-run.ts）要求"有助理且存在 credentialConfigured 的 Provider"才放行主界面。
 */
export async function configureStubProvider(harness: BackendHarness): Promise<StubProviderInfo> {
  const provider = {
    providerId: "oc-e2e-stub",
    name: "oc-e2e-stub",
    protocol: "openai-completions",
    baseUrl: harness.stubUrl,
    models: [
      {
        modelId: "oc-e2e-model-a",
        name: "oc-e2e-model-a",
        capabilities: { reasoning: false, input: ["text"] as ["text"], contextWindow: 32768, maxTokens: 4096 },
      },
    ],
  };
  const result = await apiSend<unknown>(harness.serverUrl, "PUT", "/api/settings/providers", {
    provider,
    apiKey: harness.fakeApiKey,
  });
  expect(result.ok, `配置 stub Provider 应成功：HTTP ${result.status}`).toBe(true);
  return { providerId: provider.providerId, modelId: provider.models[0]!.modelId, modelName: provider.models[0]!.name };
}

/** POST /api/agents：不经引导直接创建助理（AGENT-01 的 API 面，L1/L3 已覆盖三文件落盘） */
export async function createAgentViaApi(harness: BackendHarness, name: string): Promise<CreatedAgent> {
  const result = await apiSend<AgentViewWire>(harness.serverUrl, "POST", "/api/agents", {
    name,
    baseColor: {
      persona: `${name} 的底色描述（lane-a4d fixture）`,
      personality: ["严谨"],
      replyStyle: "简洁直接",
      innerSetting: "",
    },
  });
  expect(result.ok, `API 创建助理应成功：HTTP ${result.status}`).toBe(true);
  return { id: result.json.identity.id, name: result.json.identity.name };
}
