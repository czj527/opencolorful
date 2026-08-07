// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：Subagent 展示格式化（plans/phase-14.md §21.4）
//
// 纯函数工具：状态文案（§21.4 稳定文案逐字）、模型标签、耗时/Token/
// 相对时间格式化、Run 选择辅助。不依赖 React，便于单测。
// ═══════════════════════════════════════════════════════════════

import type {
  SubagentResultDisposition,
  SubagentRunRecord,
  SubagentRunStatus,
  SubagentThreadStatus,
} from "../../lib/types.js";

/** §21.4 稳定状态文案（不得使用未经确定性证明的语义文案） */
export const SUBAGENT_RUN_STATUS_TEXT: Readonly<Record<SubagentRunStatus, string>> = {
  queued: "正在排队",
  starting: "正在启动",
  running: "正在处理",
  waiting_for_input: "等待主 Agent 补充信息",
  cancelling: "正在取消",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  timed_out: "运行超时",
  interrupted: "服务重启后已中断",
  budget_exhausted: "预算已用尽",
};

export const SUBAGENT_THREAD_STATUS_TEXT: Readonly<Record<SubagentThreadStatus, string>> = {
  open: "进行中",
  closing: "正在关闭",
  closed: "已关闭",
};

export const SUBAGENT_RESULT_DISPOSITION_TEXT: Readonly<Record<SubagentResultDisposition, string>> = {
  satisfied: "已满足",
  partial: "部分满足",
  blocked: "受阻",
  failed: "失败",
};

export const SUBAGENT_MODEL_SOURCE_TEXT: Readonly<Record<string, string>> = {
  user_default: "用户默认",
  parent_request: "主 Agent 指定",
  parent_inherited: "继承主 Agent",
};

/** 活动态集合（对齐 SUBAGENT_RUN_ACTIVE_STATUSES） */
const ACTIVE_RUN_STATUSES: readonly SubagentRunStatus[] = [
  "queued", "starting", "running", "waiting_for_input", "cancelling",
];

export function isRunActive(status: SubagentRunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** 终态集合（对齐 SUBAGENT_RUN_TERMINAL_STATUSES） */
const TERMINAL_RUN_STATUSES: readonly SubagentRunStatus[] = [
  "succeeded", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted",
];

export function isRunTerminal(status: SubagentRunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function subagentRunStatusText(status: SubagentRunStatus): string {
  return SUBAGENT_RUN_STATUS_TEXT[status] ?? status;
}

export function subagentThreadStatusText(status: SubagentThreadStatus): string {
  return SUBAGENT_THREAD_STATUS_TEXT[status] ?? status;
}

export function subagentResultDispositionText(disposition: SubagentResultDisposition): string {
  return SUBAGENT_RESULT_DISPOSITION_TEXT[disposition] ?? disposition;
}

/** 模型标签：providerId/modelId（面板与卡片统一展示） */
export function modelLabel(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** 最近 Run：按 ordinal 取最大（runs 来自 SQLite 升序；防御性再排一次） */
export function latestRun(runs: readonly SubagentRunRecord[]): SubagentRunRecord | null {
  let latest: SubagentRunRecord | null = null;
  for (const run of runs) {
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

/** Run 序号标签：Run #N（ordinal 1 起） */
export function runLabel(ordinal: number): string {
  return `Run #${ordinal}`;
}

/** 运行时长（从 startedAt 到 now 或 finishedAt） */
export function formatRunElapsed(
  run: SubagentRunRecord | null,
  now: Date = new Date(),
): string {
  if (run === null || run.startedAt === null) return "—";
  const end = run.finishedAt !== null ? new Date(run.finishedAt).getTime() : now.getTime();
  const start = new Date(run.startedAt).getTime();
  const ms = Math.max(0, end - start);
  return formatDurationMs(ms);
}

/** 毫秒 → 人读时长："<1 秒" / "3 分 12 秒" / "1 小时 5 分" */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return "<1 秒";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds > 0 ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/** ISO 时间 → 相对时间："刚刚" / "5 分钟前" / "2 小时前" / "3 天前" */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "—";
  const deltaMs = Math.max(0, now.getTime() - time);
  if (deltaMs < 60_000) return "刚刚";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/** ISO 时间 → 本地时钟 "14:03:22" */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Token 计数 → "1.2k" / "3.4M" */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** Run 用量行："↑1.2k ↓3.4k · 总 4.6k" */
export function formatRunUsage(run: SubagentRunRecord): string {
  const input = formatTokens(run.inputTokens);
  const output = formatTokens(run.outputTokens);
  return `↑${input} ↓${output} · 总 ${formatTokens(run.totalTokens)}`;
}

/** 内容哈希短摘要："a1b2c3d4…"（前 8 位） */
export function shortHash(hash: string): string {
  return hash.length > 8 ? `${hash.slice(0, 8)}…` : hash;
}

/** 卡片的当前阶段行："正在使用工具：read" 或当前阶段文本 */
export function currentPhaseLine(run: SubagentRunRecord | null): string {
  if (run === null) return "";
  if (run.currentTool !== null && run.currentTool.length > 0) {
    return `正在使用工具：${run.currentTool}`;
  }
  return run.currentPhase ?? "";
}

/** 判断 Thread 是否可被请求取消/补充信息（只读请求，不直接控制） */
export function canRequestParentAction(run: SubagentRunRecord | null): boolean {
  return run !== null && !isRunTerminal(run.status);
}
