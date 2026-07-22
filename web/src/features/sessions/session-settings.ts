export const TOOL_MODES = ["off", "read-only", "all"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SessionSettingsFormData {
  toolMode: ToolMode;
  workspaceCwd: string;
  workspaceConfirmed: boolean;
  thinkingLevel: ThinkingLevel;
}

export interface SessionSettingsFormErrors {
  toolMode?: string;
  workspaceCwd?: string;
}

export function validateSessionSettings(data: SessionSettingsFormData): SessionSettingsFormErrors {
  const errors: SessionSettingsFormErrors = {};

  if (data.toolMode === "all") {
    if (!data.workspaceCwd.trim()) {
      errors.workspaceCwd = "all 模式必须指定工作目录";
    }
    if (data.workspaceCwd.includes("..")) {
      errors.workspaceCwd = "工作目录不允许包含 .. 路径";
    }
    if (!data.workspaceConfirmed) {
      errors.toolMode = "all 模式必须先确认工作区";
    }
  }

  return errors;
}

export function hasSessionSettingsErrors(errors: SessionSettingsFormErrors): boolean {
  return Object.values(errors).some((e) => e !== undefined);
}
