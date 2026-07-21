import { Value } from "typebox/value";

import {
  A2uiActionSchema,
  type A2uiAction,
} from "../../contracts/ui-message.js";
import { A2uiCatalog } from "./catalog.js";

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface A2uiActionValidationContext {
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly components: Readonly<Record<string, string>>;
}

const ALLOWED_ACTIONS = new Set([
  "submit",
  "cancel",
  "retry",
  "refresh",
  "select",
  "toggle",
]);

export class A2uiActionValidator {
  private readonly catalog: A2uiCatalog;

  constructor(catalog?: A2uiCatalog) {
    this.catalog = catalog ?? new A2uiCatalog();
  }

  validate(value: unknown, context: A2uiActionValidationContext): ValidationResult {
    if (!Value.Check(A2uiActionSchema, value)) {
      return { ok: false, issues: ["Action 结构无效"] };
    }
    const action = value as A2uiAction;
    const issues: string[] = [];

    if (action.sessionId !== context.sessionId) {
      issues.push("Session ID 不匹配");
    }
    if (action.surfaceId !== context.surfaceId) {
      issues.push("Surface ID 不匹配当前会话");
    }

    const componentType = context.components[action.sourceComponentId];
    if (componentType === undefined) {
      issues.push("组件不存在");
    } else if (!this.catalog.isAllowed(componentType)) {
      issues.push(`未知组件类型: ${componentType}`);
    }

    if (Number.isNaN(Date.parse(action.timestamp))) {
      issues.push("timestamp 格式无效");
    }
    if (!ALLOWED_ACTIONS.has(action.actionName)) {
      issues.push(`未知 Action: ${action.actionName}`);
    }

    const parameter = action.context?.value;
    if (
      action.actionName === "select" &&
      typeof parameter !== "string" &&
      typeof parameter !== "number"
    ) {
      issues.push("select Action 需要字符串或数字 value");
    }
    if (action.actionName === "toggle" && typeof parameter !== "boolean") {
      issues.push("toggle Action 需要布尔 value");
    }

    return { ok: issues.length === 0, issues };
  }

  getCatalog(): A2uiCatalog {
    return this.catalog;
  }
}
