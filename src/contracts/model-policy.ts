import type { MemoryAgentSettings } from "./memory.js";
import type { ModelReference, PreferencesDocument } from "./preferences.js";

/** 模型引用（来自 preferences 契约；契约面统一从这里取用） */
export type { ModelReference };

// ═══════════════════════════════════════════════════════════════
// 两档模型策略契约（P1 波次 A / A6，plans/p1-quality-model-usage.en.md §A6）
//
// human-fixed 语义（不得偏离）：
// - 只有两档：primary=主对话默认；secondary=全部非主一次性/后台工作。无第三档。
// - 选择器拥有优先级与可用性判定；调用方不得自带 fallback。
// - 绝不允许 "environment"（PI 环境内置目录）或 "first_credentialed"
//   （第一个有凭据 Provider）作为来源——枚举中不存在，实现中也不可达。
// - 冲突按优先级裁决：不阻塞、不静默，通过冲突清单可诊断。
// - 不可用模型（resolveModel UNAUTHORIZED/NOT_FOUND）归一为稳定错误码 + 中文 message。
//
// agent-recommends（PR 默认批准后生效）：字段命名、来源枚举命名、错误码命名、
// 诊断输出形态、同步签名。
// ═══════════════════════════════════════════════════════════════

/** 两档角色（human-fixed：无第三档） */
export const MODEL_SELECTION_ROLES = ["primary", "secondary"] as const;
export type ModelSelectionRole = (typeof MODEL_SELECTION_ROLES)[number];

/**
 * 选择来源枚举（必须能区分四级，按优先级从高到低）：
 * 1. explicit_request      —— 显式请求：本次请求/工具参数显式指定（如 spawn_subagent 的 model 参数）
 * 2. caller_override       —— 会话/调用方覆盖：已有 Session 的当前模型、Desktop 草稿等调用方显式值
 * 3. user_default          —— 用户默认：primary=defaults.model；secondary=subagents.defaultModel（规范默认）
 * 4. legacy_memory_utility —— 旧字段映射：memory.utilityProviderId/utilityModel（全局或 per-Agent 既有生效链）
 *
 * 构造性约束：枚举中不存在 "environment" / "first_credentialed"；
 * 选择器只从上述四级取值，永不枚举环境内置目录或第一个有凭据的 Provider。
 */
export const MODEL_SELECTION_SOURCES = [
  "explicit_request",
  "caller_override",
  "user_default",
  "legacy_memory_utility",
] as const;
export type ModelSelectionSource = (typeof MODEL_SELECTION_SOURCES)[number];

/**
 * 稳定错误码（与 errors.ts / delegation-policy 的稳定错误码风格一致）：
 * - model_not_configured      未配置任何默认（fresh 全空或 legacy 无候选），且无显式指定
 * - model_no_credentials      Provider 无凭据（resolveModel 的 UNAUTHORIZED 归一）
 * - model_unavailable         模型不存在/不可解析（resolveModel 的 NOT_FOUND 等归一）
 * - model_conflict_adjudicated 冲突已按优先级裁决——非抛错码：作为冲突裁决记录的稳定标记
 *   （附在成功结果 ModelSelection.conflict 与诊断输出上，绝不作为错误抛出）。
 */
export const MODEL_CONFLICT_ADJUDICATED_CODE = "model_conflict_adjudicated" as const;
export const MODEL_POLICY_ERROR_CODES = [
  "model_not_configured",
  "model_no_credentials",
  "model_unavailable",
  MODEL_CONFLICT_ADJUDICATED_CODE,
] as const;
export type ModelPolicyErrorCode = (typeof MODEL_POLICY_ERROR_CODES)[number];

/** 选择失败的稳定错误形状（中文 message，不含敏感输入；同输入恒同输出） */
export interface ModelSelectionError {
  readonly code: ModelPolicyErrorCode;
  readonly message: string;
}

/** 冲突清单条目：偏好字段 / 取值 / 裁决结果 */
export interface ModelConflictEntry {
  /** 偏好字段路径："subagents.defaultModel" | "memory.utility*" | "perAgent.memory.utility*" */
  readonly field: string;
  /** 取值；null = 旧字段映射不完整（只配置了 provider/model 之一），不能构成候选 */
  readonly ref: ModelReference | null;
  /** 裁决结果 */
  readonly adjudication:
    | "selected"    // 按优先级胜出并被采用
    | "superseded"  // 被更高优先级的用户默认/规范字段取代
    | "incomplete"  // 旧字段映射不完整，已忽略（不静默丢失，诊断可见）
    | "shadowed";   // 全局 memory.utility* 被 per-Agent settings.json 的 memory 段整段覆盖（既有生效链语义）
}

/** 一次冲突裁决的可诊断记录（code 恒为 model_conflict_adjudicated） */
export interface ModelSelectionConflict {
  readonly code: typeof MODEL_CONFLICT_ADJUDICATED_CODE;
  readonly role: ModelSelectionRole;
  /** 按优先级从高到低排列的参与字段 */
  readonly entries: readonly ModelConflictEntry[];
}

/** 选择结果（成功通道；字段语义 human-fixed，命名 agent-recommends） */
export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly role: ModelSelectionRole;
  readonly source: ModelSelectionSource;
  /** 仅当多个用户偏好字段同时有效并按优先级裁决时输出（不阻塞、不静默） */
  readonly conflict?: ModelSelectionConflict;
}

/** 显式指定（请求级或会话级）；存在时绕过一切用户默认，但可用性仍校验 */
export interface ModelSelectionExplicit extends ModelReference {
  /** request=本次请求/工具参数显式指定（缺省）；session=会话已有模型等调用方覆盖 */
  readonly level?: "request" | "session";
}

/** Provider 可用性探针（ModelService.listProviders 的结构化最小视图） */
export interface ModelProviderProbe {
  readonly providerId: string;
  readonly credentialConfigured: boolean;
}

/**
 * 模型可用性判定端口（结构化最小接口；生产接线直接传 ModelService——它天然满足；
 * 测试传纯函数桩）。选择器只依赖这两个方法，因此环境内置目录（listModels）
 * 在类型层面即不可达，永不成为来源。
 */
export interface ModelAvailabilityPort {
  listProviders(): readonly ModelProviderProbe[];
  /** 可用即返回；不可用（无凭据/不存在）时抛错（UNAUTHORIZED/NOT_FOUND），由选择器归一 */
  resolveModel(providerId: string, modelId: string): unknown;
}

/** selectPrimary/selectSecondary 共用上下文（依赖注入，无全局状态；同步签名） */
export interface ModelSelectionContext {
  /** 请求/会话显式指定；存在时绕过用户默认（可用性仍校验，失败→稳定错误） */
  readonly explicit?: ModelSelectionExplicit | null;
  /** 注入的偏好文档（已经 normalizePreferences 归一化的只读视图） */
  readonly preferences: PreferencesDocument;
  /** 注入的模型真相服务（仅需 listProviders/resolveModel） */
  readonly modelService: ModelAvailabilityPort;
}

/** selectSecondary 上下文：额外接受 per-Agent 记忆设置（reason 为 selectSecondary 的第一个位置参数） */
export interface SecondarySelectionContext extends ModelSelectionContext {
  /**
   * per-Agent settings.json 的 memory 段（既有生效链：段存在时整段覆盖全局 memory，
   * 与 start.ts resolveMemorySettings 一致）；缺省 = 未提供 per-Agent 覆盖，用全局。
   */
  readonly perAgent?: MemoryAgentSettings;
}
