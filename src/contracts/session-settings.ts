import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TOOL_MODES = ["off", "read-only", "all"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const SessionSettingsSchema = Type.Object({
  toolMode: Type.Optional(
    Type.Union(TOOL_MODES.map((m) => Type.Literal(m))),
  ),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  workspaceConfirmed: Type.Optional(Type.Boolean()),
  thinkingLevel: Type.Optional(
    Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))),
  ),
});

export type SessionSettings = Static<typeof SessionSettingsSchema>;

export class SessionSettingsValidationError extends Error {}

export function parseSessionSettings(value: unknown): SessionSettings {
  if (!Value.Check(SessionSettingsSchema, value)) {
    throw new SessionSettingsValidationError("Session 设置结构无效");
  }
  const settings = value as SessionSettings;

  if (settings.cwd !== undefined) {
    if (settings.cwd.includes("..")) {
      throw new SessionSettingsValidationError("工作目录不允许包含 .. 路径");
    }
    if (settings.cwd.length > 500) {
      throw new SessionSettingsValidationError("工作目录路径过长");
    }
  }

  if (settings.toolMode === "all" && !settings.workspaceConfirmed) {
    throw new SessionSettingsValidationError("all 模式必须先确认工作区");
  }

  return settings;
}

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ALL_TOOLS = [
  ...READ_ONLY_TOOLS,
  "write",
  "edit",
  "bash",
] as const;
