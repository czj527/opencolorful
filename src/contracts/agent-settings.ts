import { type Static, Type } from "typebox";

import { SandboxCapabilitiesSchema } from "./sandbox.js";

/**
 * Agent 运行设置。独立于身份与底色，存放可变运行配置。
 * settings.json 存储。
 *
 * v2：新增 sandbox 字段（可选），旧 v1 数据自动迁移。
 */
export const AgentSettingsV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    defaultCwd: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentSettingsV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    defaultCwd: Type.Union([Type.String(), Type.Null()]),
    sandbox: Type.Optional(SandboxCapabilitiesSchema),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentSettingsSchema = Type.Union([
  AgentSettingsV1Schema,
  AgentSettingsV2Schema,
]);

export type AgentSettingsV1 = Static<typeof AgentSettingsV1Schema>;
export type AgentSettingsV2 = Static<typeof AgentSettingsV2Schema>;
export type AgentSettings = Static<typeof AgentSettingsSchema>;

export function defaultAgentSettings(now?: string): AgentSettingsV2 {
  return {
    version: 2,
    defaultCwd: null,
    updatedAt: now ?? new Date().toISOString(),
  };
}

export type AgentSettingsPatch = Partial<
  Omit<AgentSettingsV2, "version" | "updatedAt">
>;
