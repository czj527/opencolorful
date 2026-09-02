/**
 * A4a lane 本地 fixture：隔离 home 内的前置数据准备（API 直连，不经 UI）。
 *
 * 目的：把"建 N 个助理 / M 个会话 / 配置 stub Provider"从 UI 链路里解耦出来，
 * 让 lane 用例聚焦矩阵行的目标交互。所有数据仍落在本用例的临时 OPENCOLORFUL_HOME。
 * 红线：Provider 一律指向 fixture 的本地 stub（禁止真实 Provider 网络）。
 */
import { expect } from "@playwright/test";

import type { BackendHarness } from "../backend.js";
import { apiSend, type AgentViewWire, type SessionViewWire } from "./api.js";

export interface StubProviderInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
}

/** PUT /api/settings/providers：注册指向本地 stub 的自定义 Provider（凭据入 AuthStorage）。
 * 注册两个模型（model-a/model-b），供 SESS-05 的模型 chip 切换使用。 */
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
      {
        modelId: "oc-e2e-model-b",
        name: "oc-e2e-model-b",
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

export interface CreatedAgent {
  readonly id: string;
  readonly name: string;
}

/** POST /api/agents：不经引导直接创建助理（AGENT-01 的 API 面，L1/L3 已覆盖三文件落盘） */
export async function createAgentViaApi(
  harness: BackendHarness,
  name: string,
  options?: { readonly persona?: string; readonly defaultCwd?: string | null },
): Promise<CreatedAgent> {
  const result = await apiSend<AgentViewWire>(harness.serverUrl, "POST", "/api/agents", {
    name,
    baseColor: {
      persona: options?.persona ?? `${name} 的底色描述（lane-a4a fixture）`,
      personality: ["严谨"],
      replyStyle: "简洁直接",
      innerSetting: "",
    },
    ...(options?.defaultCwd !== undefined ? { defaultCwd: options.defaultCwd } : {}),
  });
  expect(result.ok, `API 创建助理应成功：HTTP ${result.status}`).toBe(true);
  return { id: result.json.identity.id, name: result.json.identity.name };
}

export interface CreatedSession {
  readonly id: string;
  readonly title: string;
}

export interface CreateSessionOptions {
  readonly agentId: string;
  readonly title: string;
  readonly cwd?: string;
  readonly toolMode?: string;
  readonly workspaceConfirmed?: boolean;
  readonly thinkingLevel?: string;
}

/** POST /api/sessions：按矩阵链路需要的会话设置直接建会话 */
export async function createSessionViaApi(
  harness: BackendHarness,
  options: CreateSessionOptions,
): Promise<CreatedSession> {
  const body: Record<string, unknown> = { title: options.title, agentId: options.agentId };
  if (options.cwd !== undefined) body["cwd"] = options.cwd;
  if (options.toolMode !== undefined) body["toolMode"] = options.toolMode;
  if (options.workspaceConfirmed !== undefined) body["workspaceConfirmed"] = options.workspaceConfirmed;
  if (options.thinkingLevel !== undefined) body["thinkingLevel"] = options.thinkingLevel;
  const result = await apiSend<SessionViewWire>(harness.serverUrl, "POST", "/api/sessions", body);
  expect(result.ok, `API 创建会话应成功：HTTP ${result.status}`).toBe(true);
  return { id: result.json.id, title: result.json.title };
}
