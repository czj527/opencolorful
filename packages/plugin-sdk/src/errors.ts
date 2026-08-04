// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 插件 SDK 错误（plans/phase-12.md §15 / §19.1）
//
// SDK 辅助函数在开发期做 fail-closed 校验：非法 Manifest / Contribution
// 立即抛出 PluginSdkError（含首个 Schema 校验失败路径），插件作者在
// install 前就能发现契约问题，不依赖运行时才报错。
// ═══════════════════════════════════════════════════════════════

import Value from "typebox/value";
import type { TSchema } from "typebox";

export class PluginSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSdkError";
  }
}

/**
 * 用冻结 Schema 校验值；失败时收集首个错误路径并抛 PluginSdkError。
 * @param schema 协议包冻结 Schema（ManifestV1Schema / 各类 Contribution Schema）
 * @param value 待校验值
 * @param what 校验对象描述（错误消息用）
 */
export function assertValidWithSchema(schema: TSchema, value: unknown, what: string): void {
  if (Value.Check(schema, value)) {
    return;
  }
  let detail = "未知字段或字段非法";
  for (const error of Value.Errors(schema, value)) {
    detail = `${error.instancePath === "" ? "$" : error.instancePath}: ${error.message}`;
    break;
  }
  throw new PluginSdkError(`${what} 不符合冻结 Schema（${detail}）`);
}

/** 非空字符串断言（轻量前置校验，配合 Schema 全量校验）。 */
export function assertNonEmptyString(value: unknown, what: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginSdkError(`${what} 必须是非空字符串`);
  }
}
