// Phase 11 /logs 工作页共享格式化与展示常量。
// 磁盘预算与服务端一致（src/observability/diagnostic-logger.ts：总预算 500MB）。

/** diagnostic 日志磁盘总预算（与服务端 diagnostic-logger.ts 对齐） */
export const DISK_BUDGET_BYTES = 500 * 1024 * 1024;

/** payloadJson 展示上限：超过后截断并允许展开（约束：不渲染原始字符串超过 2000 字符） */
export const PAYLOAD_PREVIEW_LIMIT = 2_000;

const MISSING = "—";

export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return MISSING;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return MISSING;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 磁盘占用是否超过预算 80%（health 徽标提示阈值） */
export function isDiskNearLimit(totalBytes: number | null | undefined): boolean {
  if (totalBytes === null || totalBytes === undefined || !Number.isFinite(totalBytes)) return false;
  return totalBytes > DISK_BUDGET_BYTES * 0.8;
}

/**
 * 安全解析 payloadJson。解析失败时原样返回字符串，
 * 保证未知/异常 payload 以通用形式展示而不崩溃。
 */
export function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

export interface PayloadPreview {
  readonly text: string;
  readonly truncated: boolean;
}

/** JSON 化 payload 并截断到 PAYLOAD_PREVIEW_LIMIT 字符（配合「展开」按钮使用） */
export function payloadPreview(payload: unknown): PayloadPreview {
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload, null, 2);
    } catch {
      text = String(payload);
    }
  }
  const truncated = text.length > PAYLOAD_PREVIEW_LIMIT;
  return { text: truncated ? `${text.slice(0, PAYLOAD_PREVIEW_LIMIT)}…` : text, truncated };
}
