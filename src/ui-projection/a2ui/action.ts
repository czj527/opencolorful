import type { A2uiAction } from "../../contracts/ui-message.js";
import { A2uiCatalog } from "./catalog.js";

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export class A2uiActionValidator {
  private readonly catalog: A2uiCatalog;

  constructor(catalog?: A2uiCatalog) {
    this.catalog = catalog ?? new A2uiCatalog();
  }

  validate(action: A2uiAction, knownSurfaceId: string): ValidationResult {
    const issues: string[] = [];

    if (!action.actionName || action.actionName.trim() === "") {
      issues.push("Action 名称不能为空");
    }

    if (!action.surfaceId || action.surfaceId.trim() === "") {
      issues.push("Surface ID 不能为空");
    }

    if (action.surfaceId !== knownSurfaceId) {
      issues.push("Surface ID 不匹配当前会话");
    }

    if (!action.sourceComponentId || action.sourceComponentId.trim() === "") {
      issues.push("组件 ID 不能为空");
    }

    // 校验 timestamp 是有效日期
    if (isNaN(Date.parse(action.timestamp))) {
      issues.push("timestamp 格式无效");
    }

    // 校验已知安全的 action 名称
    const allowedActions = new Set([
      "submit",
      "cancel",
      "retry",
      "refresh",
      "select",
      "toggle",
    ]);
    if (!allowedActions.has(action.actionName)) {
      issues.push(`未知 Action: ${action.actionName}`);
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }

  getCatalog(): A2uiCatalog {
    return this.catalog;
  }
}
