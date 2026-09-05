import { describe, expect, it } from "vitest";

import { createApiError } from "../../src/contracts/api-error.js";
import {
  MODEL_CONFLICT_ADJUDICATED_CODE,
  MODEL_POLICY_ERROR_CODES,
  MODEL_SELECTION_SOURCES,
  type ModelAvailabilityPort,
  type ModelProviderProbe,
  type ModelReference,
  type ModelSelectionExplicit,
  type ModelSelectionSource,
} from "../../src/contracts/model-policy.js";
import { defaultMemoryAgentSettings, type MemoryAgentSettings } from "../../src/contracts/memory.js";
import { defaultPreferences, type PreferencesDocument } from "../../src/contracts/preferences.js";
import { defaultSubagentPreferences } from "../../src/contracts/subagents.js";
import {
  ModelPolicyError,
  diagnoseModelConflicts,
  selectPrimary,
  selectSecondary,
} from "../../src/runtime/model-policy.js";

// ═══════════════════════════════════════════════════════════════
// A6 契约测试：两档模型策略选择器（selectPrimary/selectSecondary）
// 证明：调用方无法再静默走旧 fallback（environment 内置目录 /
// first_credentialed / 旧字段静默回退在来源枚举与行为层面均不可达）。
// ═══════════════════════════════════════════════════════════════

const PRIMARY: ModelReference = { providerId: "faux", modelId: "faux-1" };
const OTHER: ModelReference = { providerId: "other", modelId: "other-1" };

// ── 测试桩与构造辅助 ────────────────────────────────────────────

/** 纯函数模型服务桩：镜像 pi-sdk/model-runtime.ts resolveModel 的抛错行为 */
function fakeService(options: {
  providers?: readonly ModelProviderProbe[];
  resolvable?: readonly ModelReference[];
}): ModelAvailabilityPort {
  const providers = options.providers ?? [];
  const resolvable = options.resolvable ?? [];
  return {
    listProviders: () => providers.map((provider) => ({ ...provider })),
    resolveModel(providerId, modelId) {
      const provider = providers.find((candidate) => candidate.providerId === providerId);
      if (provider === undefined || !provider.credentialConfigured) {
        throw createApiError("UNAUTHORIZED", `Provider "${providerId}" 未配置凭据`, false);
      }
      if (!resolvable.some((model) => model.providerId === providerId && model.modelId === modelId)) {
        throw createApiError("NOT_FOUND", `模型 "${providerId}/${modelId}" 不存在`, false);
      }
      return { providerId, modelId };
    },
  };
}

/** 标准服务：faux/other 有凭据且可解析，noauth 有注册无凭据 */
const SERVICE = fakeService({
  providers: [
    { providerId: "faux", credentialConfigured: true },
    { providerId: "other", credentialConfigured: true },
    { providerId: "noauth", credentialConfigured: false },
  ],
  resolvable: [PRIMARY, OTHER],
});

function memorySettings(utilityProviderId: string | null, utilityModel: string | null): MemoryAgentSettings {
  return { ...defaultMemoryAgentSettings(), utilityProviderId, utilityModel };
}

function makePrefs(options: {
  primary?: ModelReference | null;
  secondary?: ModelReference | null;
  memory?: MemoryAgentSettings | null;
}): PreferencesDocument {
  const base = defaultPreferences();
  return {
    ...base,
    defaults: { ...base.defaults, model: options.primary ?? null },
    ...(options.secondary !== undefined
      ? { subagents: { ...defaultSubagentPreferences(), defaultModel: options.secondary } }
      : {}),
    ...(options.memory !== undefined && options.memory !== null ? { memory: options.memory } : {}),
  };
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

// ── 契约枚举（构造性断言）───────────────────────────────────────

describe("契约枚举（构造性断言）", () => {
  it("来源枚举恰好四级，且不存在 environment / first_credentialed", () => {
    expect(MODEL_SELECTION_SOURCES).toEqual([
      "explicit_request",
      "caller_override",
      "user_default",
      "legacy_memory_utility",
    ]);
    expect(MODEL_SELECTION_SOURCES).not.toContain("environment");
    expect(MODEL_SELECTION_SOURCES).not.toContain("first_credentialed");
    expect(MODEL_SELECTION_SOURCES.some((source) => source.includes("environment"))).toBe(false);
    expect(MODEL_SELECTION_SOURCES.some((source) => source.includes("credentialed"))).toBe(false);
  });

  it("错误码至少覆盖：未配置任何默认 / 无凭据 / 模型不可用 / 冲突已裁决", () => {
    expect(MODEL_POLICY_ERROR_CODES).toEqual([
      "model_not_configured",
      "model_no_credentials",
      "model_unavailable",
      MODEL_CONFLICT_ADJUDICATED_CODE,
    ]);
  });

  it("选择器为纯同步函数（返回值不是 Promise）", () => {
    const primary = selectPrimary({ preferences: makePrefs({ primary: PRIMARY }), modelService: SERVICE });
    expect(primary).not.toBeInstanceOf(Promise);
    const secondary = selectSecondary("test", {
      preferences: makePrefs({ secondary: OTHER }),
      modelService: SERVICE,
    });
    expect(secondary).not.toBeInstanceOf(Promise);
  });
});

// ── selectPrimary 优先级表 ──────────────────────────────────────

interface PrimarySuccessRow {
  readonly name: string;
  readonly explicit?: ModelSelectionExplicit;
  readonly primary?: ModelReference | null;
  readonly expectedSource: ModelSelectionSource;
}

const PRIMARY_SUCCESS_ROWS: readonly PrimarySuccessRow[] = [
  {
    name: "显式请求存在 → explicit_request 胜出（defaults.model 被绕过）",
    explicit: { providerId: OTHER.providerId, modelId: OTHER.modelId },
    primary: PRIMARY,
    expectedSource: "explicit_request",
  },
  {
    name: "会话级显式覆盖（level=session）→ caller_override",
    explicit: { providerId: OTHER.providerId, modelId: OTHER.modelId, level: "session" },
    primary: PRIMARY,
    expectedSource: "caller_override",
  },
  {
    name: "无显式 + defaults.model → user_default",
    primary: PRIMARY,
    expectedSource: "user_default",
  },
];

describe("selectPrimary 优先级（显式请求 > defaults.model，无第三出路）", () => {
  it.each(PRIMARY_SUCCESS_ROWS)("$name", (row) => {
    const selection = selectPrimary({
      ...(row.explicit !== undefined ? { explicit: row.explicit } : {}),
      preferences: makePrefs({ primary: row.primary ?? null }),
      modelService: SERVICE,
    });
    expect(selection.role).toBe("primary");
    expect(selection.providerId).toBe(row.explicit?.providerId ?? PRIMARY.providerId);
    expect(selection.modelId).toBe(row.explicit?.modelId ?? PRIMARY.modelId);
    expect(selection.source).toBe(row.expectedSource);
    expect(selection.conflict).toBeUndefined();
  });

  it("全空（fresh）且无显式 → model_not_configured，不漏到环境内置目录或第一个有凭据的 Provider", () => {
    const error = captureError(() => selectPrimary({ preferences: makePrefs({}), modelService: SERVICE }));
    expect(error.code).toBe("model_not_configured");
    expect(error.message).toContain("defaults.model");
    expect(error.message).toContain("不自动回退");
  });

  it("显式指定不可用 → 稳定错误；即使 defaults.model 可用也不回落（证明显式绕过用户默认）", () => {
    const error = captureError(() =>
      selectPrimary({
        explicit: { providerId: "faux", modelId: "ghost-model" },
        preferences: makePrefs({ primary: PRIMARY }),
        modelService: SERVICE,
      }),
    );
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("faux/ghost-model");
    expect(error.message).toContain("不自动回退");
  });

  it.each([
    ["defaults.model 为 ghost（Provider 有凭据但模型不存在）", makePrefs({ primary: { providerId: "faux", modelId: "ghost" } }), "model_unavailable"],
    ["defaults.model 的 Provider 无凭据", makePrefs({ primary: { providerId: "noauth", modelId: "m" } }), "model_no_credentials"],
  ] as const)("负例：%s → %s（不 fallback）", (_name, preferences, expectedCode) => {
    const error = captureError(() => selectPrimary({ preferences, modelService: SERVICE }));
    expect(error.code).toBe(expectedCode);
    expect(error.message).toContain("不自动回退");
  });
});

// ── selectSecondary 优先级表 ────────────────────────────────────

interface SecondarySuccessRow {
  readonly name: string;
  readonly explicit?: ModelSelectionExplicit;
  readonly secondary?: ModelReference | null;
  readonly memory?: MemoryAgentSettings | null;
  readonly perAgent?: MemoryAgentSettings;
  readonly expectedSource: ModelSelectionSource;
  readonly expectedRef: ModelReference;
  readonly expectConflict: boolean;
}

const SECONDARY_SUCCESS_ROWS: readonly SecondarySuccessRow[] = [
  {
    name: "显式请求 > subagents.defaultModel > 旧字段映射（显式绕过一切用户默认）",
    explicit: { providerId: OTHER.providerId, modelId: OTHER.modelId },
    secondary: PRIMARY,
    memory: memorySettings(OTHER.providerId, OTHER.modelId),
    expectedSource: "explicit_request",
    expectedRef: OTHER,
    expectConflict: false,
  },
  {
    name: "会话级覆盖（level=session）→ caller_override",
    explicit: { providerId: OTHER.providerId, modelId: OTHER.modelId, level: "session" },
    secondary: PRIMARY,
    expectedSource: "caller_override",
    expectedRef: OTHER,
    expectConflict: false,
  },
  {
    name: "无显式 + subagents.defaultModel（规范用户默认）> 旧字段 → user_default + 冲突裁决记录",
    secondary: PRIMARY,
    memory: memorySettings(OTHER.providerId, OTHER.modelId),
    expectedSource: "user_default",
    expectedRef: PRIMARY,
    expectConflict: true,
  },
  {
    name: "仅旧字段映射（全局）→ legacy_memory_utility",
    memory: memorySettings(OTHER.providerId, OTHER.modelId),
    expectedSource: "legacy_memory_utility",
    expectedRef: OTHER,
    expectConflict: false,
  },
  {
    name: "仅旧字段映射（per-Agent 段）→ legacy_memory_utility（既有生效链保留）",
    perAgent: memorySettings(OTHER.providerId, OTHER.modelId),
    expectedSource: "legacy_memory_utility",
    expectedRef: OTHER,
    expectConflict: false,
  },
];

describe("selectSecondary 优先级（显式 > subagents.defaultModel > memory.utility* 旧字段）", () => {
  it.each(SECONDARY_SUCCESS_ROWS)("$name", (row) => {
    const selection = selectSecondary("test", {
      ...(row.explicit !== undefined ? { explicit: row.explicit } : {}),
      preferences: makePrefs({ secondary: row.secondary ?? null, memory: row.memory ?? null }),
      modelService: SERVICE,
      ...(row.perAgent !== undefined ? { perAgent: row.perAgent } : {}),
    });
    expect(selection.role).toBe("secondary");
    expect(selection.source).toBe(row.expectedSource);
    expect(selection.providerId).toBe(row.expectedRef.providerId);
    expect(selection.modelId).toBe(row.expectedRef.modelId);
    if (row.expectConflict) {
      expect(selection.conflict?.code).toBe(MODEL_CONFLICT_ADJUDICATED_CODE);
    } else {
      expect(selection.conflict).toBeUndefined();
    }
  });

  it("显式指定不可用 → 稳定错误；即使 subagents.defaultModel 可用也不回落", () => {
    const error = captureError(() =>
      selectSecondary("test", {
        explicit: { providerId: "faux", modelId: "ghost" },
        preferences: makePrefs({ secondary: PRIMARY }),
        modelService: SERVICE,
      }),
    );
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("faux/ghost");
  });

  it("subagents.defaultModel 为 ghost → 稳定错误；不静默借旧字段映射（旧 fallback 已死）", () => {
    const error = captureError(() =>
      selectSecondary("test", {
        preferences: makePrefs({
          secondary: { providerId: "faux", modelId: "ghost" },
          memory: memorySettings(OTHER.providerId, OTHER.modelId),
        }),
        modelService: SERVICE,
      }),
    );
    expect(error.code).toBe("model_unavailable");
    expect(error.conflict).toBeDefined();
    expect(error.conflict?.entries.map((entry) => entry.adjudication)).toEqual(["selected", "superseded"]);
  });

  it("胜出 Provider 无凭据 → model_no_credentials（不 fallback 到其他 Provider）", () => {
    const error = captureError(() =>
      selectSecondary("test", {
        preferences: makePrefs({ secondary: { providerId: "noauth", modelId: "m" } }),
        modelService: SERVICE,
      }),
    );
    expect(error.code).toBe("model_no_credentials");
    expect(error.message).toContain("noauth");
  });

  it("per-Agent memory 段存在但 utility 未配置 → 整段覆盖语义保留：全局旧字段被遮蔽，不借用", () => {
    const error = captureError(() =>
      selectSecondary("test", {
        preferences: makePrefs({ memory: memorySettings(OTHER.providerId, OTHER.modelId) }),
        modelService: SERVICE,
        perAgent: memorySettings(null, null),
      }),
    );
    expect(error.code).toBe("model_not_configured");
    expect(error.message).toContain("整段覆盖");
  });

  it("全空（fresh）→ model_not_configured；reason 随错误透出", () => {
    const error = captureError(() =>
      selectSecondary("memory-ticker", { preferences: makePrefs({}), modelService: SERVICE }),
    );
    expect(error.code).toBe("model_not_configured");
    expect(error.message).toContain("reason=memory-ticker");
    expect(error.message).toContain("subagents.defaultModel");
  });

  it("旧字段只配置一半（仅 utilityProviderId）→ 不构成候选，稳定错误且诊断不静默", () => {
    const error = captureError(() =>
      selectSecondary("test", {
        preferences: makePrefs({ memory: memorySettings(OTHER.providerId, null) }),
        modelService: SERVICE,
      }),
    );
    expect(error.code).toBe("model_not_configured");
    expect(error.message).toContain("仅配置一半");
  });

  it("负例稳定：同输入多次执行 code+message 恒一致（多跑一致）", () => {
    const context = {
      preferences: makePrefs({ secondary: { providerId: "noauth", modelId: "m" } }),
      modelService: SERVICE,
    };
    const first = captureError(() => selectSecondary("memory-ticker", context)).toContract();
    for (let index = 0; index < 3; index += 1) {
      expect(captureError(() => selectSecondary("memory-ticker", context)).toContract()).toEqual(first);
    }
  });
});

// ── 冲突诊断（纯函数）──────────────────────────────────────────

describe("diagnoseModelConflicts（纯函数，不涉及可用性）", () => {
  it("fresh 全空 / 单一字段 → 无冲突", () => {
    expect(diagnoseModelConflicts(makePrefs({}))).toEqual([]);
    expect(diagnoseModelConflicts(makePrefs({ primary: PRIMARY }))).toEqual([]);
    expect(diagnoseModelConflicts(makePrefs({ secondary: PRIMARY }))).toEqual([]);
    expect(
      diagnoseModelConflicts(makePrefs({ memory: memorySettings(OTHER.providerId, OTHER.modelId) })),
    ).toEqual([]);
  });

  it("subagents.defaultModel 与旧字段指向不同模型 → 冲突清单含字段/取值/裁决结果", () => {
    const conflicts = diagnoseModelConflicts(
      makePrefs({ secondary: PRIMARY, memory: memorySettings(OTHER.providerId, OTHER.modelId) }),
    );
    expect(conflicts).toHaveLength(1);
    const record = conflicts[0];
    expect(record?.code).toBe(MODEL_CONFLICT_ADJUDICATED_CODE);
    expect(record?.role).toBe("secondary");
    expect(record?.entries).toEqual([
      { field: "subagents.defaultModel", ref: PRIMARY, adjudication: "selected" },
      { field: "memory.utility*", ref: OTHER, adjudication: "superseded" },
    ]);
  });

  it("同指向多字段 → 不算冲突", () => {
    expect(
      diagnoseModelConflicts(
        makePrefs({ secondary: PRIMARY, memory: memorySettings(PRIMARY.providerId, PRIMARY.modelId) }),
      ),
    ).toEqual([]);
  });

  it("per-Agent 段整段覆盖全局（不同模型）→ shadowed 条目可见", () => {
    const conflicts = diagnoseModelConflicts(
      makePrefs({ memory: memorySettings(OTHER.providerId, OTHER.modelId) }),
      memorySettings(PRIMARY.providerId, PRIMARY.modelId),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.entries).toEqual([
      { field: "perAgent.memory.utility*", ref: PRIMARY, adjudication: "selected" },
      { field: "memory.utility*", ref: OTHER, adjudication: "shadowed" },
    ]);
  });

  it("per-Agent 段覆盖但 utility 为空（全局有配置）→ 全局被遮蔽可见（无 selected 条目）", () => {
    const conflicts = diagnoseModelConflicts(
      makePrefs({ memory: memorySettings(OTHER.providerId, OTHER.modelId) }),
      memorySettings(null, null),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.entries).toEqual([
      { field: "memory.utility*", ref: OTHER, adjudication: "shadowed" },
    ]);
  });

  it("半配置旧字段 → incomplete 条目可见（不静默丢失配置）", () => {
    const conflicts = diagnoseModelConflicts(
      makePrefs({ secondary: PRIMARY, memory: memorySettings(OTHER.providerId, null) }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.entries).toEqual([
      { field: "subagents.defaultModel", ref: PRIMARY, adjudication: "selected" },
      { field: "memory.utility*", ref: null, adjudication: "incomplete" },
    ]);
  });

  it("诊断与可用性无关：ghost 模型冲突仍按字段优先级裁决", () => {
    const ghost: ModelReference = { providerId: "faux", modelId: "ghost" };
    const conflicts = diagnoseModelConflicts(
      makePrefs({ secondary: ghost, memory: memorySettings(OTHER.providerId, OTHER.modelId) }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.entries[0]).toEqual({ field: "subagents.defaultModel", ref: ghost, adjudication: "selected" });
  });
});
