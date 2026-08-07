import {
  OBSERVABILITY_ATTRIBUTE_LIMITS,
  type SafeValue,
} from "../../../contracts/observability.js";
import {
  type SubagentArtifactRef,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { isSensitiveKey, redactText } from "../../../observability/safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Tool 可见摘要与脱敏（plans/phase-14.md §17.2 / §25.7）
//
// - SubagentToolActivityView：面板可见的工具活动（started/completed/failed/
//   denied 四态），只含名称 + 安全摘要，绝不暴露完整参数值/Secret/Header/
//   大段文件正文；
// - summarizeToolArgs：参数安全摘要——敏感 key 直接剔除（值不落盘）、
//   字符串先过 Phase 11 redactText（sk-…/Authorization/URL 凭据/PII/路径），
//   绝对路径默认转工作区相对显示，对象/数组收敛为浅层摘要，总量截断；
// - summarizeToolOutput：输出安全摘要（redact + 截断；非字符串收敛为类型+大小）；
// - SubagentToolActivityTracker：进程内 transient 跟踪（§17.2 "Tool delta 不写
//   Activity 表，但可以实时流到面板后丢弃"）——每 Thread 有界环形缓冲，
//   started → completed/failed/denied 生命周期，超容量丢弃最旧。
// ═══════════════════════════════════════════════════════════════

/** 面板可见的工具活动视图（§17.2 SubagentToolActivityView 逐字 + toolCallId/runId/threadId） */
export interface SubagentToolActivityView {
  readonly toolCallId: string;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly toolName: string;
  readonly status: "started" | "completed" | "failed" | "denied";
  readonly startedAt: string;
  readonly durationMs?: number;
  readonly inputSummary?: string;
  readonly outputSummary?: string;
  readonly reasonCode?: string;
  readonly artifactRefs?: readonly SubagentArtifactRef[];
}

export const SUBAGENT_TOOL_INPUT_SUMMARY_MAX = 512;
export const SUBAGENT_TOOL_OUTPUT_SUMMARY_MAX = 512;
export const SUBAGENT_TOOL_SUMMARY_DEPTH = 2;
export const SUBAGENT_TOOL_TRACKER_MAX_PER_THREAD = 200;

/**
 * 工具参数安全摘要：`key=value, key2=value…`（≤512 字符）。
 * - isSensitiveKey（apiKey/secret/token/authorization/…）→ 值不落盘；
 * - 字符串值先 redactText（sk-…/Bearer/URL 凭据/Email/Phone/路径）再截断；
 * - 绝对路径键（path/filePath/relativePath/cwd/directory）转工作区相对显示；
 * - 对象/数组收敛为 `{n keys}` / `[n items]`（深度 2 内的标量可见）；
 * - 顶层键数量过多时保留前 8 个并标记省略。
 */
export function summarizeToolArgs(
  toolName: string,
  args: unknown,
  options: { readonly workspaceCwd?: string; readonly maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? SUBAGENT_TOOL_INPUT_SUMMARY_MAX;
  if (args === null || typeof args !== "object") {
    return scalarSummary(args);
  }
  const record = Array.isArray(args)
    ? arrayAsRecord(args)
    : (args as Record<string, unknown>);
  const entries = Object.entries(record);
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (parts.length >= 8) {
      parts.push(`…${entries.length - 8} more`);
      break;
    }
    if (isSensitiveKey(key)) {
      parts.push(`${key}=[REDACTED]`);
      continue;
    }
    if (isPathKey(key) && typeof value === "string" && options.workspaceCwd !== undefined) {
      parts.push(`${key}=${relativizePath(value, options.workspaceCwd)}`);
      continue;
    }
    parts.push(`${key}=${valueSummary(value, 0, maxLength)}`);
    if (parts.join(", ").length > maxLength) {
      parts.push("…(truncated)");
      break;
    }
  }
  const summary = parts.join(", ");
  return summary.length > maxLength
    ? `${summary.slice(0, maxLength)}…(truncated)`
    : (summary || "(empty)");
}

/** 工具输出安全摘要：redact + 截断；非字符串收敛为类型+大小 */
export function summarizeToolOutput(
  toolName: string,
  output: unknown,
  options: { readonly workspaceCwd?: string; readonly maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? SUBAGENT_TOOL_OUTPUT_SUMMARY_MAX;
  if (typeof output === "string") {
    const redacted = redactText(output);
    const relative = options.workspaceCwd !== undefined ? relativizePath(redacted, options.workspaceCwd) : redacted;
    return relative.length > maxLength ? `${relative.slice(0, maxLength)}…(truncated)` : relative;
  }
  if (typeof output === "number" || typeof output === "boolean" || output === null) {
    return String(output);
  }
  if (Array.isArray(output)) {
    return `[array ${output.length}]`;
  }
  if (typeof output === "object") {
    try {
      return `[object ${Object.keys(output as Record<string, unknown>).length} keys]`;
    } catch {
      return "[object]";
    }
  }
  return String(output).slice(0, maxLength);
}

/** 单值摘要（深度有界；字符串 redact+截断，对象/数组收敛） */
function valueSummary(value: unknown, depth: number, maxLength: number): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length > 160 ? `${redacted.slice(0, 160)}…` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= SUBAGENT_TOOL_SUMMARY_DEPTH) return typeof value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.slice(0, 3).map((item) => valueSummary(item, depth + 1, maxLength));
    const more = value.length > 3 ? `…+${value.length - 3}` : "";
    return `[${items.join(", ")}${more}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const items = entries.slice(0, 3).map(([key, item]) => {
      if (isSensitiveKey(key)) return `${key}=[REDACTED]`;
      return `${key}:${valueSummary(item, depth + 1, maxLength)}`;
    });
    const more = entries.length > 3 ? `…+${entries.length - 3}` : "";
    return `{${items.join(", ")}${more}}`;
  }
  return String(value).slice(0, 80);
}

function scalarSummary(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length > 160 ? `${redacted.slice(0, 160)}…` : redacted;
  }
  return String(value);
}

function arrayAsRecord(args: readonly unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  args.forEach((item, index) => {
    record[String(index)] = item;
  });
  return record;
}

/** 路径类参数键（绝对路径默认转工作区相对显示，§17.2） */
function isPathKey(key: string): boolean {
  return /^(?:path|filePath|relativePath|directory|cwd|workingDir|file)$/i.test(key);
}

/** 绝对路径 → 工作区相对显示；非工作区内路径保留原样（由 redactText 先行清洗） */
export function relativizePath(value: string, workspaceCwd: string): string {
  const normalized = value.replace(/\\/g, "/");
  const cwd = workspaceCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cwd !== "" && normalized.startsWith(`${cwd}/`)) {
    return `.${normalized.slice(cwd.length)}`;
  }
  return normalized;
}

/** SafeValue 收敛（observability payload attributes 用；不暴露原文） */
export function summarizeAsSafeValue(value: unknown): SafeValue {
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length > OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength
      ? `${redacted.slice(0, OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength)}…(truncated)`
      : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => summarizeAsSafeValue(item));
  }
  if (typeof value === "object") {
    const result: Record<string, SafeValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;
      result[key] = summarizeAsSafeValue(item);
    }
    return result;
  }
  return String(value).slice(0, 200);
}

/**
 * 进程内 transient Tool 活动跟踪（§17.2：Tool delta 不落 durable，实时流到
 * 面板后丢弃）。有界环形缓冲（每 Thread SUBAGENT_TOOL_TRACKER_MAX_PER_THREAD），
 * started → completed/failed/denied 生命周期；同一 toolCallId 重复 started 幂等。
 */
export class SubagentToolActivityTracker {
  private readonly perThread = new Map<
    SubagentThreadId,
    Map<string, SubagentToolActivityView>
  >();
  private readonly subscribers = new Set<(view: SubagentToolActivityView) => void>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** started：幂等（同一 toolCallId 已存在则返回原视图） */
  started(input: {
    readonly threadId: SubagentThreadId;
    readonly runId: SubagentRunId;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args?: unknown;
    readonly workspaceCwd?: string;
  }): SubagentToolActivityView {
    const bucket = this.bucketOf(input.threadId);
    const existing = bucket.get(input.toolCallId);
    if (existing !== undefined) return existing;
    const view: SubagentToolActivityView = {
      toolCallId: input.toolCallId,
      threadId: input.threadId,
      runId: input.runId,
      toolName: input.toolName,
      status: "started",
      startedAt: this.now().toISOString(),
      ...(input.args !== undefined
        ? {
            inputSummary: summarizeToolArgs(input.toolName, input.args, {
              ...(input.workspaceCwd !== undefined ? { workspaceCwd: input.workspaceCwd } : {}),
            }),
          }
        : {}),
    };
    bucket.set(input.toolCallId, view);
    this.emit(view);
    return view;
  }

  /** completed：输出安全摘要 + 可选 artifactRefs */
  completed(input: {
    readonly threadId: SubagentThreadId;
    readonly toolCallId: string;
    readonly output?: unknown;
    readonly workspaceCwd?: string;
    readonly artifactRefs?: readonly SubagentArtifactRef[];
  }): SubagentToolActivityView | null {
    const current = this.bucketOf(input.threadId).get(input.toolCallId);
    if (current === undefined || current.status !== "started") return null;
    const view: SubagentToolActivityView = {
      ...current,
      status: "completed",
      durationMs: Math.max(0, this.now().getTime() - Date.parse(current.startedAt)),
      ...(input.output !== undefined
        ? {
            outputSummary: summarizeToolOutput(current.toolName, input.output, {
              ...(input.workspaceCwd !== undefined ? { workspaceCwd: input.workspaceCwd } : {}),
            }),
          }
        : {}),
      ...(input.artifactRefs !== undefined && input.artifactRefs.length > 0 ? { artifactRefs: [...input.artifactRefs] } : {}),
    };
    this.bucketOf(input.threadId).set(input.toolCallId, view);
    this.emit(view);
    return view;
  }

  /** failed：reasonCode（安全摘要，不暴露内部细节） */
  failed(input: {
    readonly threadId: SubagentThreadId;
    readonly toolCallId: string;
    readonly reasonCode?: string;
  }): SubagentToolActivityView | null {
    return this.terminal(input, "failed", input.reasonCode);
  }

  /** denied：策略拒绝（如 read Run 触发 workspace-write 工具） */
  denied(input: {
    readonly threadId: SubagentThreadId;
    readonly toolCallId: string;
    readonly reasonCode?: string;
  }): SubagentToolActivityView | null {
    return this.terminal(input, "denied", input.reasonCode);
  }

  /** 最近活动（面板初始渲染/断线重连快照；只含终态或未完成 started） */
  listRecent(
    threadId: SubagentThreadId,
    limit = 50,
  ): SubagentToolActivityView[] {
    const bucket = this.perThread.get(threadId);
    if (bucket === undefined) return [];
    return [...bucket.values()].slice(-Math.min(Math.max(limit, 1), SUBAGENT_TOOL_TRACKER_MAX_PER_THREAD));
  }

  /** 订阅实时工具事件（SSE 面板流）；返回退订函数 */
  subscribe(listener: (view: SubagentToolActivityView) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  clear(threadId: SubagentThreadId): void {
    this.perThread.delete(threadId);
  }

  private terminal(
    input: { readonly threadId: SubagentThreadId; readonly toolCallId: string },
    status: "failed" | "denied",
    reasonCode: string | undefined,
  ): SubagentToolActivityView | null {
    const bucket = this.bucketOf(input.threadId);
    const current = bucket.get(input.toolCallId);
    if (current === undefined || current.status !== "started") return null;
    const view: SubagentToolActivityView = {
      ...current,
      status,
      durationMs: Math.max(0, this.now().getTime() - Date.parse(current.startedAt)),
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    };
    bucket.set(input.toolCallId, view);
    this.emit(view);
    return view;
  }

  private bucketOf(threadId: SubagentThreadId): Map<string, SubagentToolActivityView> {
    let bucket = this.perThread.get(threadId);
    if (bucket === undefined) {
      bucket = new Map();
      this.perThread.set(threadId, bucket);
    }
    while (bucket.size >= SUBAGENT_TOOL_TRACKER_MAX_PER_THREAD) {
      const oldest = bucket.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
    return bucket;
  }

  private emit(view: SubagentToolActivityView): void {
    for (const subscriber of this.subscribers) {
      setImmediate(() => {
        if (this.subscribers.has(subscriber)) {
          try {
            subscriber(view);
          } catch {
            // 一个面板订阅者的同步写入失败不能影响其他订阅者
          }
        }
      });
    }
  }
}
