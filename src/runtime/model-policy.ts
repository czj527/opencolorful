import {
  MODEL_CONFLICT_ADJUDICATED_CODE,
  type ModelAvailabilityPort,
  type ModelConflictEntry,
  type ModelPolicyErrorCode,
  type ModelReference,
  type ModelSelection,
  type ModelSelectionConflict,
  type ModelSelectionContext,
  type ModelSelectionError,
  type ModelSelectionExplicit,
  type ModelSelectionSource,
  type SecondarySelectionContext,
} from "../contracts/model-policy.js";
import type { MemoryAgentSettings } from "../contracts/memory.js";
import { isApiError } from "../contracts/api-error.js";
import type { PreferencesDocument } from "../contracts/preferences.js";
import type { ModelService } from "./model-service.js";

// ═══════════════════════════════════════════════════════════════
// 两档模型策略选择器（P1 波次 A / A6）。
//
// 纯函数 + 依赖注入（preferences / modelService 均由调用方注入，无全局单例、
// 无内存态），A7 接线时可直接替换调用点内联逻辑（sessions.ts 默认模型应用、
// start.ts completeText 双级 fallback、desktop App.tsx 草稿兜底）。
//
// 同步签名（agent-delegated）：ModelService.listProviders/resolveModel 均为同步，
// 选择器因此保持同步，调用方需要异步语义时自行 Promise 包裹即可。
//
// 严格策略先例：delegation-policy.ts resolveSubagentModel——无 fallback + 稳定
// 错误码。本选择器把同一范式推广到两档（primary/secondary）：
// - 优先级由选择器独占：显式 > 用户默认 > 旧字段映射，全部缺失/不可用 → 稳定错误；
// - 绝不枚举环境内置目录（listModels 在端口类型层面不可达），
//   绝不选用第一个有凭据的 Provider；
// - resolveModel 的 UNAUTHORIZED/NOT_FOUND 归一为稳定错误码 + 中文 message，
//   不抛裸 PI 错误（与 completeText 现有「解析失败抛错 → 组件转 degraded」同构兼容）。
// ═══════════════════════════════════════════════════════════════

// 编译期保证：生产 ModelService 满足选择器端口（A7 可直接传入，无需适配层）。
type _AssertModelServiceSatisfiesPort = ModelService extends ModelAvailabilityPort ? true : never;
const _modelServiceSatisfiesPort: _AssertModelServiceSatisfiesPort = true;
void _modelServiceSatisfiesPort;

/** 模型策略稳定错误：code + 中文 message（Error 子类，可被既有 catch 块直接捕获） */
export class ModelPolicyError extends Error {
  readonly code: ModelPolicyErrorCode;
  /** 冲突裁决记录（仅当本次选择经历了偏好字段冲突裁决时附加） */
  readonly conflict: ModelSelectionConflict | undefined;

  constructor(code: ModelPolicyErrorCode, message: string, conflict?: ModelSelectionConflict) {
    super(message);
    this.name = "ModelPolicyError";
    this.code = code;
    this.conflict = conflict;
  }

  /** 转为稳定错误契约形状（API/UI 透出用） */
  toContract(): ModelSelectionError {
    return { code: this.code, message: this.message };
  }
}

// ── 可用性判定与错误归一 ────────────────────────────────────────

function noCredentialsMessage(ref: ModelReference): string {
  return `Provider "${ref.providerId}" 未配置凭据，模型 "${ref.providerId}/${ref.modelId}" 不可用；两档模型策略不自动回退到其他 Provider`;
}

/**
 * 可用性判定（选择器独占，调用方不得自带）：
 * 1. listProviders 中该 Provider 已配置但无凭据 → model_no_credentials（不调用 PI）；
 * 2. resolveModel 抛错 → 归一：UNAUTHORIZED→model_no_credentials，NOT_FOUND→model_unavailable，
 *    其他稳定码随 message 透出；非 ApiError 一律 model_unavailable（不透出原始 message）。
 */
function ensureAvailable(service: ModelAvailabilityPort, ref: ModelReference): void {
  const provider = service.listProviders().find((candidate) => candidate.providerId === ref.providerId);
  if (provider !== undefined && !provider.credentialConfigured) {
    throw new ModelPolicyError("model_no_credentials", noCredentialsMessage(ref));
  }
  try {
    service.resolveModel(ref.providerId, ref.modelId);
  } catch (error) {
    throw normalizeResolveError(ref, error);
  }
}

function normalizeResolveError(ref: ModelReference, error: unknown): ModelPolicyError {
  if (isApiError(error)) {
    if (error.code === "UNAUTHORIZED") {
      return new ModelPolicyError("model_no_credentials", noCredentialsMessage(ref));
    }
    if (error.code !== "NOT_FOUND") {
      return new ModelPolicyError(
        "model_unavailable",
        `模型 "${ref.providerId}/${ref.modelId}" 不可用（${error.code}）；两档模型策略不自动回退到其他模型`,
      );
    }
  }
  return new ModelPolicyError(
    "model_unavailable",
    `模型 "${ref.providerId}/${ref.modelId}" 不存在或不可解析；两档模型策略不自动回退到其他模型`,
  );
}

function explicitSource(explicit: ModelSelectionExplicit): ModelSelectionSource {
  return explicit.level === "session" ? "caller_override" : "explicit_request";
}

// ── selectPrimary（主对话默认档）───────────────────────────────

/**
 * primary 优先级（选择器独占）：显式请求 > defaults.model；
 * 都缺/不可用 → 稳定错误。绝不静默漏到环境内置目录或第一个有凭据的 Provider。
 * primary 档偏好只有 defaults.model 一个字段，不存在偏好级冲突。
 */
export function selectPrimary(context: ModelSelectionContext): ModelSelection {
  const explicit = context.explicit;
  if (explicit !== null && explicit !== undefined) {
    // 显式存在时绕过用户默认（可用性仍校验，失败→稳定错误，不回落 defaults.model）
    ensureAvailable(context.modelService, explicit);
    return {
      providerId: explicit.providerId,
      modelId: explicit.modelId,
      role: "primary",
      source: explicitSource(explicit),
    };
  }
  const preferred = context.preferences.defaults.model;
  if (preferred !== null) {
    ensureAvailable(context.modelService, preferred);
    return {
      providerId: preferred.providerId,
      modelId: preferred.modelId,
      role: "primary",
      source: "user_default",
    };
  }
  throw new ModelPolicyError(
    "model_not_configured",
    "未配置主对话默认模型 defaults.model，且无显式指定；两档模型策略不自动回退到环境内置目录或第一个有凭据的 Provider",
  );
}

// ── selectSecondary（全部非主一次性/后台工作档）────────────────

/** 参与次档裁决的偏好字段（按优先级从高到低收集） */
interface SecondaryPreferenceField {
  readonly field: string;
  readonly ref: ModelReference | null;
  readonly legacy: boolean;
  /** 全局 memory.utility* 被 per-Agent settings.json 的 memory 段整段覆盖 */
  readonly shadowed: boolean;
}

const SUBAGENTS_FIELD = "subagents.defaultModel";
const GLOBAL_MEMORY_FIELD = "memory.utility*";
const PER_AGENT_MEMORY_FIELD = "perAgent.memory.utility*";

/** 旧字段映射：utilityProviderId/utilityModel 必须同时配置才构成候选（半配置 → null） */
function legacyMemoryRef(settings: MemoryAgentSettings | undefined): ModelReference | null {
  const providerId = settings?.utilityProviderId ?? null;
  const modelId = settings?.utilityModel ?? null;
  if (providerId === null || modelId === null || providerId.trim() === "" || modelId.trim() === "") {
    return null;
  }
  return { providerId, modelId };
}

/** 旧字段映射不完整（恰好只配置了 provider/model 之一；都未配置 = 字段不存在） */
function legacyMemoryIncomplete(settings: MemoryAgentSettings | undefined): boolean {
  if (settings === undefined) return false;
  const providerSet = settings.utilityProviderId !== null && settings.utilityProviderId.trim() !== "";
  const modelSet = settings.utilityModel !== null && settings.utilityModel.trim() !== "";
  return providerSet !== modelSet;
}

/** 收集次档偏好字段（既有生效链保留：per-Agent settings.json 的 memory 段存在时
 * 整段覆盖全局 memory——与 start.ts resolveMemorySettings 一致）。
 * 只读取 preferences/perAgent 两个字段，冲突诊断因此无需注入 modelService。 */
function collectSecondaryFields(
  context: Pick<SecondarySelectionContext, "preferences" | "perAgent">,
): readonly SecondaryPreferenceField[] {
  const fields: SecondaryPreferenceField[] = [];
  const subagentsDefault = context.preferences.subagents?.defaultModel ?? null;
  if (subagentsDefault !== null) {
    fields.push({ field: SUBAGENTS_FIELD, ref: subagentsDefault, legacy: false, shadowed: false });
  }
  const perAgentProvided = context.perAgent !== undefined;
  const globalRef = legacyMemoryRef(context.preferences.memory);
  const globalIncomplete = legacyMemoryIncomplete(context.preferences.memory);
  if (perAgentProvided) {
    const perAgentRef = legacyMemoryRef(context.perAgent);
    const perAgentIncomplete = legacyMemoryIncomplete(context.perAgent);
    if (perAgentRef !== null) {
      fields.push({ field: PER_AGENT_MEMORY_FIELD, ref: perAgentRef, legacy: true, shadowed: false });
    } else if (perAgentIncomplete) {
      fields.push({ field: PER_AGENT_MEMORY_FIELD, ref: null, legacy: true, shadowed: false });
    }
    if (globalRef !== null || globalIncomplete) {
      fields.push({ field: GLOBAL_MEMORY_FIELD, ref: globalRef, legacy: true, shadowed: true });
    }
  } else if (globalRef !== null) {
    fields.push({ field: GLOBAL_MEMORY_FIELD, ref: globalRef, legacy: true, shadowed: false });
  } else if (globalIncomplete) {
    fields.push({ field: GLOBAL_MEMORY_FIELD, ref: null, legacy: true, shadowed: false });
  }
  return fields;
}

function sameRef(a: ModelReference, b: ModelReference): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * 冲突裁决（纯函数，不涉及可用性）：同一档多个用户设置字段同时存在且指向
 * 不同模型、或存在不完整/被整段覆盖的字段时输出裁决记录；按优先级裁决，
 * 不阻塞、不静默。全部字段指向同一模型且无缺失时不产生记录。
 */
function adjudicateSecondaryFields(
  fields: readonly SecondaryPreferenceField[],
): ModelSelectionConflict | null {
  if (fields.length === 0) return null;
  const completeRefs: ModelReference[] = [];
  for (const field of fields) {
    if (field.ref !== null && !field.shadowed) completeRefs.push(field.ref);
  }
  const winner = completeRefs[0];
  const hasDifferingCompleteRefs =
    winner !== undefined && completeRefs.some((ref) => !sameRef(ref, winner));
  const hasIncomplete = fields.some((field) => field.ref === null);
  const hasDifferingShadowed = fields.some(
    (field) =>
      field.shadowed &&
      field.ref !== null &&
      (winner === undefined || !sameRef(field.ref, winner)),
  );
  if (!hasDifferingCompleteRefs && !hasIncomplete && !hasDifferingShadowed) {
    return null;
  }

  let winnerAssigned = false;
  const entries: ModelConflictEntry[] = fields.map((field) => {
    if (field.ref === null) {
      return { field: field.field, ref: null, adjudication: "incomplete" };
    }
    if (!field.shadowed && !winnerAssigned) {
      winnerAssigned = true;
      return { field: field.field, ref: field.ref, adjudication: "selected" };
    }
    return {
      field: field.field,
      ref: field.ref,
      adjudication: field.shadowed ? "shadowed" : "superseded",
    };
  });
  return { code: MODEL_CONFLICT_ADJUDICATED_CODE, role: "secondary", entries };
}

function secondaryNotConfiguredMessage(fields: readonly SecondaryPreferenceField[]): string {
  const notes: string[] = [];
  for (const field of fields) {
    if (field.ref === null) {
      notes.push(
        field.shadowed
          ? `全局 ${field.field} 仅配置一半，且被 per-Agent memory 段整段覆盖，未参与选择`
          : `${field.field} 仅配置一半（旧字段映射不完整），未参与选择`,
      );
    } else if (field.shadowed) {
      notes.push(`全局 ${field.field} 被 per-Agent settings.json 的 memory 段整段覆盖（既有生效链语义），未参与选择`);
    }
  }
  const suffix = notes.length > 0 ? `（${notes.join("；")}）` : "";
  return `未配置次档模型 subagents.defaultModel，且无可用的 memory.utilityProviderId/utilityModel 旧字段映射${suffix}；两档模型策略不自动回退到环境内置目录或第一个有凭据的 Provider`;
}

/**
 * secondary 优先级（选择器独占）：显式请求 > subagents.defaultModel（规范用户默认）>
 * memory.utility* 旧字段映射（全局与 per-Agent 既有生效链保留）；
 * 都缺/不可用 → 稳定错误。绝不静默借用 primary 或第一个有凭据的 Provider。
 */
export function selectSecondary(reason: string, context: SecondarySelectionContext): ModelSelection {
  const explicit = context.explicit;
  if (explicit !== null && explicit !== undefined) {
    // 显式存在时绕过一切用户默认与旧字段映射（可用性仍校验，失败→稳定错误）
    ensureAvailable(context.modelService, explicit);
    return {
      providerId: explicit.providerId,
      modelId: explicit.modelId,
      role: "secondary",
      source: explicitSource(explicit),
    };
  }

  const fields = collectSecondaryFields(context);
  const conflict = adjudicateSecondaryFields(fields) ?? undefined;
  // 胜出字段 = 优先级最高且映射完整、未被 per-Agent 段整段覆盖的字段
  const winner = fields.find((field) => field.ref !== null && !field.shadowed);
  const prefix = reason.trim() === "" ? "" : `（reason=${reason.trim()}）`;

  if (winner === undefined || winner.ref === null) {
    throw new ModelPolicyError(
      "model_not_configured",
      `次档模型选择失败${prefix}：${secondaryNotConfiguredMessage(fields)}`,
      conflict,
    );
  }

  try {
    ensureAvailable(context.modelService, winner.ref);
  } catch (error) {
    // 冲突裁决失败可诊断：错误对象附带裁决记录（不静默、不改道更低优先级字段）
    if (error instanceof ModelPolicyError && conflict !== undefined && error.conflict === undefined) {
      throw new ModelPolicyError(error.code, error.message, conflict);
    }
    throw error;
  }

  return {
    providerId: winner.ref.providerId,
    modelId: winner.ref.modelId,
    role: "secondary",
    source: winner.legacy ? "legacy_memory_utility" : "user_default",
    ...(conflict !== undefined ? { conflict } : {}),
  };
}

// ── 冲突诊断（纯函数，不涉及可用性）────────────────────────────

/**
 * 诊断偏好文档中的模型设置冲突（primary 档仅 defaults.model 一个字段，无偏好级冲突；
 * 冲突只可能出现在 secondary 档：subagents.defaultModel 与 memory.utility* 旧字段映射、
 * 以及全局与 per-Agent 覆盖之间）。输出冲突清单（含字段/取值/裁决结果），
 * 无冲突返回空数组。
 */
export function diagnoseModelConflicts(
  preferences: PreferencesDocument,
  perAgent?: MemoryAgentSettings,
): readonly ModelSelectionConflict[] {
  const context: Pick<SecondarySelectionContext, "preferences" | "perAgent"> = {
    preferences,
    ...(perAgent !== undefined ? { perAgent } : {}),
  };
  const conflict = adjudicateSecondaryFields(collectSecondaryFields(context));
  return conflict !== null ? [conflict] : [];
}
