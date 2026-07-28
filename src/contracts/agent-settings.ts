import { type Static, Type } from "typebox";

/**
 * Agent 运行设置。独立于身份与底色，存放可变运行配置。
 * settings.json 存储。
 */
export const AgentSettingsSchema = Type.Object(
  {
    version: Type.Literal(1),
    defaultCwd: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export type AgentSettings = Static<typeof AgentSettingsSchema>;

export function defaultAgentSettings(now?: string): AgentSettings {
  return {
    version: 1,
    defaultCwd: null,
    updatedAt: now ?? new Date().toISOString(),
  };
}

export type AgentSettingsPatch = Partial<Omit<AgentSettings, "version" | "updatedAt">>;
