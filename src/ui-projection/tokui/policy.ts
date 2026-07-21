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
  "icon",
  "upd",
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

const ALLOWED_HANDLER_PREFIXES = new Set([
  "action:",
  "nav:",
  "toggle:",
  "select:",
]);

export const TOKUI_MAX_BUFFER = 1_048_576; // 1MB
export const TOKUI_MAX_DEPTH = 100;
export const TOKUI_MAX_CHUNK_LENGTH = 65_536; // 64KB

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export class TokuiPolicy {
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

    // 检查深度（粗略计算嵌套标签数）
    let depth = 0;
    let maxDepth = 0;
    for (const char of chunk) {
      if (char === "[") depth += 1;
      if (char === "]") depth -= 1;
      maxDepth = Math.max(maxDepth, depth);
    }
    if (maxDepth > TOKUI_MAX_DEPTH) {
      issues.push(`嵌套深度 ${maxDepth} 超过限制 ${TOKUI_MAX_DEPTH}`);
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

    // 检查 handler 白名单
    const handlerPattern = /clk:([a-zA-Z][a-zA-Z0-9._:-]*)/g;
    let hMatch = handlerPattern.exec(chunk);
    while (hMatch !== null) {
      const handler = hMatch[1];
      if (handler !== undefined) {
        const hasAllowedPrefix = [...ALLOWED_HANDLER_PREFIXES].some((prefix) =>
          handler.startsWith(prefix),
        );
        if (!hasAllowedPrefix) {
          issues.push(`未注册的 Handler: ${handler}`);
        }
      }
      hMatch = handlerPattern.exec(chunk);
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
    return [...ALLOWED_HANDLER_PREFIXES].some((prefix) =>
      name.startsWith(prefix),
    );
  }
}
