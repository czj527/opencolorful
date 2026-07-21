const ALLOWED_COMPONENTS = new Set([
  "card",
  "badge",
  "desc",
  "p",
  "h1",
  "h2",
  "h3",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "plan",
  "status",
  "tool-call",
  "progress",
  "btn",
  "alert",
  "callout",
  "icon",
  "upd",
  "plan-step",
]);

const FORBIDDEN_ATTRIBUTES = new Set([
  "html",
  "sandbox",
  "script",
  "eval",
  "src",
  "onload",
  "onerror",
]);

const DEFAULT_ALLOWED_HANDLERS = new Set([
  "action:submit",
  "action:cancel",
  "action:retry",
  "action:refresh",
  "nav:home",
]);

export const TOKUI_MAX_BUFFER = 1_048_576; // 1MB
export const TOKUI_MAX_DEPTH = 100;
export const TOKUI_MAX_CHUNK_LENGTH = 65_536; // 64KB

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export class TokuiPolicy {
  private readonly allowedHandlers: ReadonlySet<string>;

  constructor(additionalHandlers: Iterable<string> = []) {
    this.allowedHandlers = new Set([
      ...DEFAULT_ALLOWED_HANDLERS,
      ...additionalHandlers,
    ]);
  }

  validateChunk(chunk: string): ValidationResult {
    const issues: string[] = [];

    if (chunk.length > TOKUI_MAX_CHUNK_LENGTH) {
      issues.push(`chunk 超过长度限制 ${TOKUI_MAX_CHUNK_LENGTH}`);
    }

    // 检查禁止的属性
    for (const attr of FORBIDDEN_ATTRIBUTES) {
      const pattern = new RegExp(`\\b${attr}[\\s=:\\]]`, "i");
      if (pattern.test(chunk)) {
        issues.push(`禁止使用属性: ${attr}`);
      }
    }

    // 检查组件嵌套深度
    let depth = 0;
    let maxDepth = 0;
    const tagPattern = /\[(\/)?([a-z][a-z0-9_-]*)/gi;
    let tagMatch = tagPattern.exec(chunk);
    while (tagMatch !== null) {
      if (tagMatch[1] === "/") {
        depth -= 1;
      } else {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      }
      tagMatch = tagPattern.exec(chunk);
    }
    if (maxDepth > TOKUI_MAX_DEPTH) {
      issues.push(`组件嵌套深度 ${maxDepth} 超过限制 ${TOKUI_MAX_DEPTH}`);
    }

    // 检查组件白名单
    const componentPattern = /\[(\/)?([a-z][a-z0-9_-]*)/gi;
    let match = componentPattern.exec(chunk);
    while (match !== null) {
      const type = match[2];
      if (type !== undefined && match[1] !== "/" && !ALLOWED_COMPONENTS.has(type)) {
        issues.push(`未知 TokUI 组件: ${type}`);
      }
      match = componentPattern.exec(chunk);
    }

    // 检查 clk/sub 命名 handler。
    const handlerPattern = /\b(?:clk|sub):([a-zA-Z][a-zA-Z0-9._:-]*)/g;
    let hMatch = handlerPattern.exec(chunk);
    while (hMatch !== null) {
      const handler = hMatch[1];
      if (handler !== undefined) {
        if (!this.allowedHandlers.has(handler)) {
          issues.push(`未注册的 Handler: ${handler}`);
        }
      }
      hMatch = handlerPattern.exec(chunk);
    }

    // on:"event:handler,event:handler" 使用第一个冒号分隔事件名与 handler。
    const onPattern = /\bon:"([^"]*)"/g;
    let onMatch = onPattern.exec(chunk);
    while (onMatch !== null) {
      for (const binding of (onMatch[1] ?? "").split(",")) {
        const separator = binding.indexOf(":");
        const handler = separator === -1 ? "" : binding.slice(separator + 1);
        if (handler === "" || !this.allowedHandlers.has(handler)) {
          issues.push(`未注册的 Handler: ${handler || binding}`);
        }
      }
      onMatch = onPattern.exec(chunk);
    }

    // 禁止 raw HTML
    if (/<[a-zA-Z][^>]*>/g.test(chunk)) {
      issues.push("禁止使用原始 HTML");
    }

    return { ok: issues.length === 0, issues };
  }

  validateComponent(type: string): boolean {
    return ALLOWED_COMPONENTS.has(type);
  }

  validateHandler(name: string): boolean {
    return this.allowedHandlers.has(name);
  }
}
