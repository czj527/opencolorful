import { Type, type Static } from "typebox";

import { THINKING_LEVELS, TOOL_MODES, type ThinkingLevel, type ToolMode } from "./session-settings.js";
import { MemoryAgentSettingsSchema, defaultMemoryAgentSettings, type MemoryAgentSettings } from "./memory.js";
import { Value } from "typebox/value";

/**
 * 全局偏好文档。Phase 4 起作为新建 Session 的默认值来源和 Web 布局持久化载体。
 *
 * 设计约束：
 * - 文件缺失/损坏时回退默认值，不阻塞 Supervisor 启动；
 * - 读取时忽略未知字段，写回时只保留合法字段；
 * - 任何 API 响应都不包含凭据。
 */
/** 可观测性全局默认（Phase 11 §十：级别、保留期、大小上限；diagnostic 磁盘预算 500MB） */
export const ObservabilityPreferencesSchema = Type.Object(
  {
    diagnosticLevel: Type.Union([
      Type.Literal("trace"), Type.Literal("debug"), Type.Literal("info"),
      Type.Literal("warn"), Type.Literal("error"), Type.Literal("fatal"),
    ]),
    diagnosticRetentionDays: Type.Object({
      debug: Type.Integer({ minimum: 1, maximum: 60 }),
      main: Type.Integer({ minimum: 1, maximum: 365 }),
    }),
    diagnosticFileSizeBytes: Type.Integer({ minimum: 1_048_576, maximum: 104_857_600 }),
    diagnosticDiskBudgetBytes: Type.Integer({ minimum: 10_485_760, maximum: 10_737_418_240 }),
    activityRetentionDays: Type.Object({
      routine: Type.Integer({ minimum: 7, maximum: 730 }),
      notable: Type.Integer({ minimum: 30, maximum: 3650 }),
    }),
    emergencySpoolBudgetBytes: Type.Integer({ minimum: 1_048_576, maximum: 1_073_741_824 }),
  },
  { additionalProperties: false },
);
export type ObservabilityPreferences = Static<typeof ObservabilityPreferencesSchema>;

export function defaultObservabilityPreferences(): ObservabilityPreferences {
  return {
    diagnosticLevel: "info",
    diagnosticRetentionDays: { debug: 7, main: 30 },
    diagnosticFileSizeBytes: 10 * 1024 * 1024,
    diagnosticDiskBudgetBytes: 500 * 1024 * 1024,
    activityRetentionDays: { routine: 180, notable: 730 },
    emergencySpoolBudgetBytes: 128 * 1024 * 1024,
  };
}

export const PreferencesDocumentSchema = Type.Object(
  {
    version: Type.Literal(2),
    defaults: Type.Object({
      model: Type.Union([
        Type.Object({ providerId: Type.String(), modelId: Type.String() }),
        Type.Null(),
      ]),
      thinkingLevel: Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))),
      toolMode: Type.Union(TOOL_MODES.map((mode) => Type.Literal(mode))),
    }),
    layout: Type.Object({
      leftSidebarWidth: Type.Number({ minimum: 200, maximum: 420 }),
      rightSidebarWidth: Type.Number({ minimum: 240, maximum: 520 }),
      leftCollapsed: Type.Boolean(),
      rightCollapsed: Type.Boolean(),
      focusMode: Type.Boolean(),
      reducedMotion: Type.Union([
        Type.Literal("system"),
        Type.Literal("on"),
        Type.Literal("off"),
      ]),
    }),
    appearance: Type.Object({
      theme: Type.Union([Type.Literal("dark"), Type.Literal("light")]),
      showToolCalls: Type.Boolean(),
      showThinking: Type.Boolean(),
      timelineVisible: Type.Optional(Type.Boolean()),
    }),
    // Phase 10.5：全局记忆默认（per-Agent settings.json 的 memory 段可覆盖）
    memory: Type.Optional(MemoryAgentSettingsSchema),
    // Phase 11：可观测性全局默认（级别/保留/预算）
    observability: Type.Optional(ObservabilityPreferencesSchema),
  },
  { additionalProperties: false },
);

export interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface DefaultsPreferences {
  readonly model: ModelReference | null;
  readonly thinkingLevel: ThinkingLevel;
  readonly toolMode: ToolMode;
}

export interface LayoutPreferences {
  readonly leftSidebarWidth: number;
  readonly rightSidebarWidth: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly focusMode: boolean;
  readonly reducedMotion: "system" | "on" | "off";
}

export interface AppearancePreferences {
  readonly theme: "dark" | "light";
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
  readonly timelineVisible?: boolean;
}

export interface PreferencesDocument {
  readonly version: 2;
  readonly defaults: DefaultsPreferences;
  readonly layout: LayoutPreferences;
  readonly appearance: AppearancePreferences;
  readonly memory?: MemoryAgentSettings;
  readonly observability?: ObservabilityPreferences;
}

const LEFT_MIN = 200;
const LEFT_MAX = 420;
const RIGHT_MIN = 240;
const RIGHT_MAX = 520;

const REDUCED_MOTION_VALUES = ["system", "on", "off"] as const;

export function defaultPreferences(): PreferencesDocument {
  return {
    version: 2,
    defaults: {
      model: null,
      thinkingLevel: "medium",
      toolMode: "read-only",
    },
    layout: {
      // 左侧 Session 列表默认较窄；右侧 Inspector 含设置，默认更宽。
      leftSidebarWidth: 280,
      rightSidebarWidth: 320,
      leftCollapsed: false,
      rightCollapsed: false,
      focusMode: false,
      reducedMotion: "system",
    },
    appearance: {
      theme: "dark",
      showToolCalls: true,
      showThinking: true,
      timelineVisible: true,
    },
    observability: defaultObservabilityPreferences(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : fallback;
}

function pickToolMode(value: unknown, fallback: ToolMode): ToolMode {
  return typeof value === "string" && (TOOL_MODES as readonly string[]).includes(value)
    ? (value as ToolMode)
    : fallback;
}

function pickReducedMotion(
  value: unknown,
  fallback: LayoutPreferences["reducedMotion"],
): LayoutPreferences["reducedMotion"] {
  return typeof value === "string" && (REDUCED_MOTION_VALUES as readonly string[]).includes(value)
    ? (value as LayoutPreferences["reducedMotion"])
    : fallback;
}

function normalizeModel(value: unknown): DefaultsPreferences["model"] {
  if (value === null) return null;
  if (isObject(value)) {
    const { providerId, modelId } = value;
    if (
      typeof providerId === "string" &&
      providerId.length > 0 &&
      typeof modelId === "string" &&
      modelId.length > 0
    ) {
      return { providerId, modelId };
    }
  }
  return null;
}

function normalizeDefaults(value: unknown, fallback: DefaultsPreferences): DefaultsPreferences {
  if (!isObject(value)) return { ...fallback };
  return {
    model: normalizeModel(value.model),
    thinkingLevel: pickThinkingLevel(value.thinkingLevel, fallback.thinkingLevel),
    toolMode: pickToolMode(value.toolMode, fallback.toolMode),
  };
}

function normalizeLayout(value: unknown, fallback: LayoutPreferences): LayoutPreferences {
  if (!isObject(value)) return { ...fallback };
  return {
    leftSidebarWidth: clampNumber(value.leftSidebarWidth, LEFT_MIN, LEFT_MAX, fallback.leftSidebarWidth),
    rightSidebarWidth: clampNumber(value.rightSidebarWidth, RIGHT_MIN, RIGHT_MAX, fallback.rightSidebarWidth),
    leftCollapsed: clampBoolean(value.leftCollapsed, fallback.leftCollapsed),
    rightCollapsed: clampBoolean(value.rightCollapsed, fallback.rightCollapsed),
    focusMode: clampBoolean(value.focusMode, fallback.focusMode),
    reducedMotion: pickReducedMotion(value.reducedMotion, fallback.reducedMotion),
  };
}

const THEME_VALUES = ["dark", "light"] as const;

function normalizeAppearance(value: unknown, fallback: AppearancePreferences): AppearancePreferences {
  if (!isObject(value)) return { ...fallback };
  return {
    theme:
      typeof value.theme === "string" && (THEME_VALUES as readonly string[]).includes(value.theme)
        ? (value.theme as AppearancePreferences["theme"])
        : fallback.theme,
    showToolCalls:
      typeof value.showToolCalls === "boolean" ? value.showToolCalls : fallback.showToolCalls,
    showThinking:
      typeof value.showThinking === "boolean" ? value.showThinking : fallback.showThinking,
    timelineVisible:
      typeof value.timelineVisible === "boolean"
        ? value.timelineVisible
        : (fallback.timelineVisible ?? true),
  };
}

/**
 * 把任意（可能来自外部或损坏文件的）输入归一化为合法的偏好文档。
 * 忽略未知字段，对越界值做 clamp 或回退，保证返回值始终满足 schema。
 */
/**
 * 把任意（可能来自外部或损坏文件的）输入归一化为合法的偏好文档。
 * v1 → v2 迁移：补 observability 默认段，其余字段原样归一化；未知字段忽略。
 */
export function normalizePreferences(value: unknown): PreferencesDocument {
  const fallback = defaultPreferences();
  if (!isObject(value)) return { ...fallback };

  const memory = normalizeMemorySettings(value.memory);
  // v1 → v2 迁移：observability 缺失时补默认段（Phase 11 保证新字段始终存在）
  const observability = normalizeObservabilitySettings(value.observability) ?? { ...defaultObservabilityPreferences() };
  return {
    version: 2,
    defaults: normalizeDefaults(value.defaults, fallback.defaults),
    layout: normalizeLayout(value.layout, fallback.layout),
    appearance: normalizeAppearance(value.appearance, fallback.appearance),
    ...(memory !== undefined ? { memory } : {}),
    observability,
  };
}

/** 可观测性设置：严格按 schema 校验（忽略未知字段/非法值），缺失回退全局默认 */
function normalizeObservabilitySettings(value: unknown): ObservabilityPreferences | undefined {
  if (value === undefined) return undefined;
  return Value.Check(ObservabilityPreferencesSchema, value)
    ? (value as ObservabilityPreferences)
    : { ...defaultObservabilityPreferences() };
}

/** 记忆设置：严格按 schema 校验（忽略未知字段/非法值），缺失回退全局默认 */
function normalizeMemorySettings(value: unknown): MemoryAgentSettings | undefined {
  if (value === undefined) return undefined;
  return Value.Check(MemoryAgentSettingsSchema, value)
    ? (value as MemoryAgentSettings)
    : { ...defaultMemoryAgentSettings() };
}