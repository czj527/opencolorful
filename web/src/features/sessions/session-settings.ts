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

/**
 * 从 Session 视图构建表单初始值（按 session.id 重建，避免跨会话串扰）。
 */
export function settingsFormFromSession(session: {
  toolMode: string;
  workspaceCwd: string | null;
  workspaceConfirmed: boolean;
  thinkingLevel: string;
}): SessionSettingsFormData {
  return {
    toolMode: (TOOL_MODES as readonly string[]).includes(session.toolMode)
      ? (session.toolMode as ToolMode)
      : "read-only",
    workspaceCwd: session.workspaceCwd ?? "",
    workspaceConfirmed: session.workspaceConfirmed,
    thinkingLevel: (THINKING_LEVELS as readonly string[]).includes(session.thinkingLevel)
      ? (session.thinkingLevel as ThinkingLevel)
      : "medium",
  };
}

/**
 * 表单变更的状态转移。安全规则：
 * - 从非 all 切换到 all → 强制取消确认（必须重新勾选）；
 * - 工作目录偏离已持久化值 → 强制取消确认；
 * - 切换到非 all → 确认状态不影响校验，但保留以便回切。
 */
export function applySessionSettingsChange(
  prev: SessionSettingsFormData,
  change: Partial<SessionSettingsFormData>,
  persistedCwd: string | null,
): SessionSettingsFormData {
  const next: SessionSettingsFormData = { ...prev, ...change };

  if (change.toolMode === "all" && prev.toolMode !== "all") {
    next.workspaceConfirmed = false;
  }

  if (change.workspaceCwd !== undefined) {
    const baseline = persistedCwd ?? "";
    if (change.workspaceCwd !== baseline) {
      next.workspaceConfirmed = false;
    }
  }

  return next;
}
