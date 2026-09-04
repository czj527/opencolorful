import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import { ProviderStore } from "../../src/config/provider-store.js";
import { ModelService } from "../../src/runtime/model-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { defaultMemoryAgentSettings, type MemoryAgentSettings } from "../../src/contracts/memory.js";
import { defaultPreferences, type PreferencesDocument } from "../../src/contracts/preferences.js";
import {
  ModelPolicyError,
  diagnoseModelConflicts,
  selectPrimary,
  selectSecondary,
} from "../../src/runtime/model-policy.js";

// ═══════════════════════════════════════════════════════════════
// A6 兼容/迁移集成测试：PreferencesStore（真实磁盘）× 选择器 × 真实
// ModelService（PI faux provider，隔离 OPENCOLORFUL_HOME，无网络依赖）。
// 证明：fresh（全空）与 legacy（仅旧字段）加载语义一致；subagents 段
// write/reopen 保留；旧字段映射、迁移与冲突裁决走同一 canonical policy。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function createPaths() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-model-policy-"));
  temporaryDirectories.push(directory);
  return getRuntimePaths({ OPENCOLORFUL_HOME: directory });
}

function providerInput() {
  return {
    providerId: "local-openai",
    name: "Local OpenAI",
    protocol: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: {},
    models: [
      {
        modelId: "local-model",
        name: "Local Model",
        capabilities: {
          reasoning: false,
          input: ["text" as const],
          contextWindow: 32_768,
          maxTokens: 4_096,
        },
      },
    ],
  };
}

async function createContext() {
  const paths = createPaths();
  const database = openMetadataDatabase(paths.database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" },
  });
  const modelService = await ModelService.create(paths, new ProviderStore(paths.providerSettings), audit);
  // 注册 faux provider 并写入凭据（resolveModel 为本地注册表查找，无网络请求）
  await modelService.upsert(providerInput(), "test-api-key");
  const preferencesStore = new PreferencesStore(paths.preferences);
  return { paths, database, modelService, preferencesStore };
}

/** 构造"旧版"偏好原始文件：v2 形状但无 subagents/observability 段（旧版本写入的内容） */
function legacyRawDocument(options: {
  defaultsModel?: { providerId: string; modelId: string } | null;
  memory?: MemoryAgentSettings;
}): Record<string, unknown> {
  const raw = defaultPreferences() as unknown as Record<string, unknown>;
  delete raw["subagents"];
  delete raw["observability"];
  const defaults = raw["defaults"] as Record<string, unknown>;
  defaults["model"] = options.defaultsModel ?? null;
  if (options.memory !== undefined) {
    raw["memory"] = options.memory;
  }
  return raw;
}

function memoryWithUtility(utilityProviderId: string | null, utilityModel: string | null): MemoryAgentSettings {
  return { ...defaultMemoryAgentSettings(), utilityProviderId, utilityModel };
}

function captureError(run: () => unknown): ModelPolicyError {
  try {
    run();
  } catch (error) {
    if (error instanceof ModelPolicyError) return error;
    throw new Error(`预期 ModelPolicyError，实际抛出：${String(error)}`);
  }
  throw new Error("预期抛出 ModelPolicyError，但选择成功返回");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      /* ignore */
    }
  }
});

describe("旧偏好兼容与迁移（PreferencesStore × 选择器 × 真实 ModelService）", () => {
  it("legacy：仅 memory.utility* 旧字段 → selectSecondary 命中旧字段映射，无冲突", async () => {
    const ctx = await createContext();
    try {
      fs.writeFileSync(
        ctx.paths.preferences,
        `${JSON.stringify(legacyRawDocument({ memory: memoryWithUtility("local-openai", "local-model") }), null, 2)}\n`,
        "utf8",
      );
      const preferences = ctx.preferencesStore.get();
      // 归一化补齐新段，但旧字段一律映射保留（不删除不改名）
      expect(preferences.version).toBe(2);
      expect(preferences.memory?.utilityProviderId).toBe("local-openai");
      expect(preferences.memory?.utilityModel).toBe("local-model");
      expect(preferences.subagents?.defaultModel).toBeNull();

      const selection = selectSecondary("memory-ticker", { preferences, modelService: ctx.modelService });
      expect(selection.role).toBe("secondary");
      expect(selection.source).toBe("legacy_memory_utility");
      expect(selection.providerId).toBe("local-openai");
      expect(selection.modelId).toBe("local-model");
      expect(selection.conflict).toBeUndefined();
      expect(diagnoseModelConflicts(preferences)).toEqual([]);
    } finally {
      ctx.database.close();
    }
  });

  it("fresh：全空偏好 → primary/secondary 均稳定错误（与 legacy 加载语义一致，不静默兜底）", async () => {
    const ctx = await createContext();
    try {
      const preferences = ctx.preferencesStore.get();
      expect(preferences.version).toBe(2);
      expect(preferences.defaults.model).toBeNull();

      const primaryError = captureError(() =>
        selectPrimary({ preferences, modelService: ctx.modelService }),
      );
      expect(primaryError.code).toBe("model_not_configured");
      const secondaryError = captureError(() =>
        selectSecondary("rolling-summary", { preferences, modelService: ctx.modelService }),
      );
      expect(secondaryError.code).toBe("model_not_configured");
      expect(secondaryError.message).toContain("不自动回退");
    } finally {
      ctx.database.close();
    }
  });

  it("subagents 段 write/reopen 保留；与旧字段同指向时裁决为 user_default 且无冲突", async () => {
    const ctx = await createContext();
    try {
      ctx.preferencesStore.update({
        subagents: { defaultModel: { providerId: "local-openai", modelId: "local-model" } },
        memory: memoryWithUtility("local-openai", "local-model"),
      });
      // 重开（新实例重读磁盘）
      const reopened = new PreferencesStore(ctx.paths.preferences).get();
      expect(reopened.subagents?.defaultModel).toEqual({ providerId: "local-openai", modelId: "local-model" });

      const selection = selectSecondary("memory-ticker", { preferences: reopened, modelService: ctx.modelService });
      expect(selection.source).toBe("user_default");
      expect(selection.providerId).toBe("local-openai");
      expect(selection.modelId).toBe("local-model");
      expect(selection.conflict).toBeUndefined();
    } finally {
      ctx.database.close();
    }
  });

  it("subagents 与旧字段指向不同模型 → 按优先级裁决并给出冲突清单", async () => {
    const ctx = await createContext();
    try {
      ctx.preferencesStore.update({
        subagents: { defaultModel: { providerId: "local-openai", modelId: "local-model" } },
        memory: memoryWithUtility("ghost-provider", "ghost-model"),
      });
      const preferences = ctx.preferencesStore.get();
      const selection = selectSecondary("memory-ticker", { preferences, modelService: ctx.modelService });
      expect(selection.source).toBe("user_default");
      expect(selection.conflict?.code).toBe("model_conflict_adjudicated");
      expect(selection.conflict?.entries).toEqual([
        { field: "subagents.defaultModel", ref: { providerId: "local-openai", modelId: "local-model" }, adjudication: "selected" },
        { field: "memory.utility*", ref: { providerId: "ghost-provider", modelId: "ghost-model" }, adjudication: "superseded" },
      ]);
    } finally {
      ctx.database.close();
    }
  });

  it("v1 → v2 迁移：defaults.model 与 memory.utility* 一律映射保留，primary/secondary 各归其位", async () => {
    const ctx = await createContext();
    try {
      const raw = legacyRawDocument({
        defaultsModel: { providerId: "local-openai", modelId: "local-model" },
        memory: memoryWithUtility("local-openai", "local-model"),
      });
      raw["version"] = 1;
      fs.writeFileSync(ctx.paths.preferences, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      const preferences = ctx.preferencesStore.get();
      expect(preferences.version).toBe(2);
      expect(preferences.defaults.model).toEqual({ providerId: "local-openai", modelId: "local-model" });
      expect(preferences.memory?.utilityModel).toBe("local-model");

      const primary = selectPrimary({ preferences, modelService: ctx.modelService });
      expect(primary.role).toBe("primary");
      expect(primary.source).toBe("user_default");
      const secondary = selectSecondary("memory-ticker", { preferences, modelService: ctx.modelService });
      expect(secondary.role).toBe("secondary");
      expect(secondary.source).toBe("legacy_memory_utility");
    } finally {
      ctx.database.close();
    }
  });

  it("ghost 默认模型：真实 resolveModel NOT_FOUND → 归一 model_unavailable，且 store 不静默改写用户配置", async () => {
    const ctx = await createContext();
    try {
      ctx.preferencesStore.update({
        defaults: {
          model: { providerId: "local-openai", modelId: "ghost-model" },
          thinkingLevel: "medium",
          toolMode: "read-only",
        },
      });
      const preferences: PreferencesDocument = ctx.preferencesStore.get();
      expect(preferences.defaults.model).toEqual({ providerId: "local-openai", modelId: "ghost-model" });

      const error = captureError(() => selectPrimary({ preferences, modelService: ctx.modelService }));
      expect(error.code).toBe("model_unavailable");
      expect(error.message).toContain("ghost-model");
      expect(error.message).toContain("不自动回退");
    } finally {
      ctx.database.close();
    }
  });

  it("无凭据 Provider：真实 resolveModel UNAUTHORIZED → 归一 model_no_credentials", async () => {
    const ctx = await createContext();
    try {
      ctx.preferencesStore.update({
        subagents: { defaultModel: { providerId: "ghost-provider", modelId: "ghost-model" } },
      });
      const preferences = ctx.preferencesStore.get();
      const error = captureError(() =>
        selectSecondary("memory-ticker", { preferences, modelService: ctx.modelService }),
      );
      expect(error.code).toBe("model_no_credentials");
      expect(error.message).toContain("ghost-provider");
      expect(error.message).toContain("不自动回退");
    } finally {
      ctx.database.close();
    }
  });
});
