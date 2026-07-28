import { type Static, Type } from "typebox";

import type { AgentSettings } from "./agent-settings.js";

/**
 * Agent 身份证（护照）。每个 Agent 创建时生成一份永久的身份编码。
 * identity.json 不可变字段，仅在创建时写入（version 2，废弃旧 type 枚举）。
 */
export const AgentIdentitySchema = Type.Object(
  {
    version: Type.Literal(2),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export type AgentIdentity = Static<typeof AgentIdentitySchema>;

/**
 * 装饰色调色板。与 UI 设计令牌 ramps 对齐，仅用于 Agent 选择界面的视觉区分。
 * 装饰色不持久化，也无人格含义——基于 Agent ID 稳定生成。
 */
export const DECOR_COLORS = [
  "blue",
  "teal",
  "coral",
  "amber",
  "purple",
  "pink",
  "green",
] as const;
export type DecorColor = (typeof DECOR_COLORS)[number];

/**
 * 根据 Agent ID 稳定生成装饰色。同一 ID 永远返回同一颜色。
 * 算法：简单字符串哈希 → 模 7 映射到调色板。
 */
export function decorColorFromId(agentId: string): DecorColor {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return DECOR_COLORS[Math.abs(hash) % DECOR_COLORS.length]!;
}

/**
 * Agent 底色（人格配置）。独立于身份，可随时编辑。base-color.json 存储。
 * innerSetting 不得承担工具权限、职业能力、工作流程或场景 Prompt。
 */
export const BaseColorSchema = Type.Object(
  {
    version: Type.Literal(1),
    persona: Type.String(),
    personality: Type.Array(Type.String()),
    replyStyle: Type.String(),
    innerSetting: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export type BaseColor = Static<typeof BaseColorSchema>;

/**
 * Agent 完整视图（API 返回）。
 * - identity 不可变身份
 * - baseColor 必须存在（空白底色合法，不存在 null 状态）
 * - settings 运行设置（含默认工作目录）
 * - decorColor 基于身份动态计算的装饰色，不持久化
 */
export interface AgentView {
  readonly identity: AgentIdentity;
  readonly baseColor: BaseColor;
  readonly settings: AgentSettings;
  readonly sessionCount: number;
  readonly decorColor: DecorColor;
}

export type AgentIdentityPatch = Partial<Omit<AgentIdentity, "version" | "id" | "createdAt">>;

export type BaseColorPatch = Partial<Omit<BaseColor, "version" | "updatedAt">>;

/**
 * 创建 Agent 时传入的底色初始值（不含 version/updatedAt，由 store 填充）。
 */
export interface BaseColorInput {
  readonly persona: string;
  readonly personality: readonly string[];
  readonly replyStyle: string;
  readonly innerSetting: string;
}

/**
 * 空白底色。四项全空字符串是合法状态。
 */
export function defaultBaseColor(now?: string): BaseColor {
  return {
    version: 1,
    persona: "",
    personality: [],
    replyStyle: "",
    innerSetting: "",
    updatedAt: now ?? new Date().toISOString(),
  };
}
