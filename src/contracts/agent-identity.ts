import { Type } from "typebox";

/**
 * Agent 身份证（护照）。每个 Agent 创建时生成一份永久的身份编码。
 * identity.json 不可变字段，仅在创建时写入。
 */
export const AgentIdentitySchema = Type.Object(
  {
    version: Type.Literal(1),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
    type: Type.Union([
      Type.Literal("assistant"),
      Type.Literal("coding"),
      Type.Literal("work"),
    ]),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export type AgentIdentity = {
  readonly version: 1;
  readonly id: string;
  readonly type: "assistant" | "coding" | "work";
  readonly name: string;
  readonly createdAt: string;
};

/**
 * Agent 行为属性。与身份证分离，可随时编辑。
 * profile.json 存储。
 */
export const AgentProfileSchema = Type.Object(
  {
    version: Type.Literal(1),
    persona: Type.String(),
    personality: Type.Array(Type.String()),
    replyStyle: Type.String({ minLength: 1, maxLength: 100 }),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export type AgentProfile = {
  readonly version: 1;
  readonly persona: string;
  readonly personality: readonly string[];
  readonly replyStyle: string;
  readonly updatedAt: string;
};

export interface AgentView {
  readonly identity: AgentIdentity;
  readonly profile: AgentProfile | null; // null = 尚未设置 profile
  readonly sessionCount: number;
}

export const AGENT_TYPES = ["assistant", "coding", "work"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const REPLY_STYLES = ["简洁", "详细", "专业", "日常", "幽默", "严谨"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];

export function defaultProfile(now?: string): AgentProfile {
  return {
    version: 1,
    persona: "",
    personality: [],
    replyStyle: "日常",
    updatedAt: now ?? new Date().toISOString(),
  };
}
