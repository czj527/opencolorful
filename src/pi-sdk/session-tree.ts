import fs from "node:fs";
import path from "node:path";

import {
  SessionManager,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

import { getSessionManager } from "./session-manager-registry.js";
import type { HistoryToolCall, PiMessageEntry, PiSessionHandle } from "./types.js";

/**
 * P1 波次B B1：PI 会话树受控适配器。
 *
 * 只暴露受控的 SessionManager 树原语（tree / branch / fork / leaf 读取），
 * 不暴露 navigateTree（B0 §3.5 冻结决策 1：regenerate 走 leaf 原语 +
 * 下一次 append，避免扩展钩子与 branch_summary 副作用）。
 * 所有输入条目 id 都先经 getEntry 校验，把 PI 的裸 Error 转成类型化
 * PiSessionTreeError；PI JSONL 仍是消息正文与分支历史的唯一事实来源。
 */

export type PiSessionEntryType =
  | "message"
  | "compaction"
  | "branch_summary"
  | "label"
  | "custom"
  | "custom_message"
  | "model_change"
  | "thinking_level_change"
  | "session_info";

export interface PiSessionTreeEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly type: PiSessionEntryType;
  readonly role?: "user" | "assistant" | "toolResult";
  /** message 正文 / compaction summary / label 文本；其余类型为 "" */
  readonly text: string;
  readonly timestamp: string;
  /** 仅 assistant 消息携带；与现有 PiMessageEntry 完全一致的拍平规则（500 字符结果截断） */
  readonly toolCalls?: HistoryToolCall[];
}

export interface PiSessionTreeNode {
  readonly entry: PiSessionTreeEntry;
  readonly children: readonly PiSessionTreeNode[];
}

export type PiSessionTreeErrorCode = "entry_not_found" | "invalid_target";

export class PiSessionTreeError extends Error {
  readonly code: PiSessionTreeErrorCode;

  constructor(code: PiSessionTreeErrorCode, message: string) {
    super(message);
    this.name = "PiSessionTreeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 消息拍平（自 wrapSessionManager.getEntries 原样抽取，保证 PiMessageEntry
// 输出逐字节一致；工具结果沿用既有 500 字符截断与 error/completed 约定）
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function extractThinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter(
      (block): block is { type: "thinking"; thinking: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string",
    )
    .map((block) => block.thinking)
    .join("");
  return thinking || undefined;
}

interface ToolResultSummary {
  status: "completed" | "error";
  result: string;
}

/** 第一遍：构建 toolCallId → tool result 映射（原 getEntries 逻辑） */
function buildToolResultIndex(entries: readonly SessionEntry[]): Map<string, ToolResultSummary> {
  const toolResults = new Map<string, ToolResultSummary>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const resultText = extractTextContent(message.content);
    // 截断结果，遵循现有脱敏/限长约定
    const truncated = resultText.length > 500 ? `${resultText.slice(0, 500)}…` : resultText;
    toolResults.set(message.toolCallId, {
      status: message.isError === true ? "error" : "completed",
      result: truncated,
    });
  }
  return toolResults;
}

/** assistant 消息的 toolCalls 抽取（原 getEntries 逻辑） */
function buildHistoryToolCalls(
  content: unknown,
  toolResults: Map<string, ToolResultSummary>,
): HistoryToolCall[] {
  const toolCalls: HistoryToolCall[] = [];
  if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
        const tr = toolResults.get(block.id);
        toolCalls.push({
          toolCallId: block.id,
          toolName: block.name,
          status: tr?.status ?? "completed",
          ...(tr?.result !== undefined ? { result: tr.result } : {}),
        } as HistoryToolCall);
      }
    }
  }
  return toolCalls;
}

/**
 * 把一条分支（根→叶）的 SessionEntry 序列拍平为 PiMessageEntry 列表。
 * 与原 wrapSessionManager.getEntries 逐字节一致；index.ts 复用此函数。
 */
export function flattenMessageEntries(branch: readonly SessionEntry[]): PiMessageEntry[] {
  const toolResults = buildToolResultIndex(branch);

  // 第二遍：构建消息条目
  const entries: PiMessageEntry[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: unknown;
    };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = extractTextContent(message.content);

    if (message.role === "user") {
      entries.push({ role: "user", content });
    } else {
      // assistant 消息
      const thinking = extractThinkingContent(message.content);
      const toolCalls = buildHistoryToolCalls(message.content, toolResults);
      const entry: PiMessageEntry = {
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
      entries.push(entry);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 树条目转换
// ---------------------------------------------------------------------------

const TOOL_RESULT_TEXT_LIMIT = 500;

function truncateToolResultText(text: string): string {
  return text.length > TOOL_RESULT_TEXT_LIMIT ? `${text.slice(0, TOOL_RESULT_TEXT_LIMIT)}…` : text;
}

function toPiSessionTreeEntry(
  entry: SessionEntry,
  toolResults: Map<string, ToolResultSummary>,
): PiSessionTreeEntry {
  const base = {
    entryId: entry.id,
    parentId: entry.parentId,
    type: entry.type as PiSessionEntryType,
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message as { role?: string; content?: unknown };
    const role =
      message.role === "user" || message.role === "assistant" || message.role === "toolResult"
        ? message.role
        : undefined;
    const text = extractTextContent(message.content);
    if (message.role === "assistant") {
      const toolCalls = buildHistoryToolCalls(message.content, toolResults);
      return {
        ...base,
        ...(role === undefined ? {} : { role }),
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    }
    // toolResult 条目自身的正文沿用 500 字符限长约定，避免整段工具输出进入导航视图
    return {
      ...base,
      ...(role === undefined ? {} : { role }),
      text: role === "toolResult" ? truncateToolResultText(text) : text,
    };
  }
  if (entry.type === "compaction") {
    return { ...base, text: entry.summary };
  }
  if (entry.type === "label") {
    return { ...base, text: entry.label ?? "" };
  }
  return { ...base, text: "" };
}

function toPiSessionTreeNodes(
  nodes: readonly SessionTreeNode[],
  toolResults: Map<string, ToolResultSummary>,
): PiSessionTreeNode[] {
  return nodes.map((node) => ({
    entry: toPiSessionTreeEntry(node.entry, toolResults),
    children: toPiSessionTreeNodes(node.children, toolResults),
  }));
}

// ---------------------------------------------------------------------------
// 受控原语
// ---------------------------------------------------------------------------

/** 全量会话树（孤儿条目也作为根返回；子节点按时间戳升序）。 */
export function getSessionTree(handle: PiSessionHandle): readonly PiSessionTreeNode[] {
  const manager = getSessionManager(handle);
  // 树覆盖所有分支：用全文件条目建 toolResult 索引，兄弟分支的结果也能正确带出
  const toolResults = buildToolResultIndex(manager.getEntries());
  return toPiSessionTreeNodes(manager.getTree(), toolResults);
}

/**
 * 当前分支（或指定条目所在分支）的条目列表，根→叶顺序。
 * 缺省从当前叶子回溯；fromEntryId 不存在时抛 entry_not_found。
 */
export function getBranchEntries(
  handle: PiSessionHandle,
  fromEntryId?: string,
): readonly PiSessionTreeEntry[] {
  const manager = getSessionManager(handle);
  if (fromEntryId !== undefined && manager.getEntry(fromEntryId) === undefined) {
    throw new PiSessionTreeError("entry_not_found", `会话条目不存在：${fromEntryId}`);
  }
  const branch = manager.getBranch(fromEntryId);
  // 与 messageEntries 的拍平语义保持一致：索引仅基于本分支条目
  const toolResults = buildToolResultIndex(branch);
  return branch.map((entry) => toPiSessionTreeEntry(entry, toolResults));
}

/** 按 id 解析单个条目；不存在时返回 undefined。 */
export function resolveEntry(handle: PiSessionHandle, entryId: string): PiSessionTreeEntry | undefined {
  const manager = getSessionManager(handle);
  const entry = manager.getEntry(entryId);
  if (entry === undefined) return undefined;
  const toolResults = buildToolResultIndex(manager.getEntries());
  return toPiSessionTreeEntry(entry, toolResults);
}

/**
 * 把叶子指针移动到指定条目（仅指针移动，无 I/O）。
 * 下一次 append 会成为该条目的子节点，形成新的兄弟分支。
 */
export function branchTo(handle: PiSessionHandle, entryId: string): void {
  const manager = getSessionManager(handle);
  if (manager.getEntry(entryId) === undefined) {
    throw new PiSessionTreeError("entry_not_found", `会话条目不存在：${entryId}`);
  }
  manager.branch(entryId);
}

/** 把叶子指针重置到根之前；下一次 append 会成为新的根条目。 */
export function branchToRoot(handle: PiSessionHandle): void {
  getSessionManager(handle).resetLeaf();
}

/** 当前叶子条目 id；空会话或已 branchToRoot 后为 null。 */
export function getLeafEntryId(handle: PiSessionHandle): string | null {
  return getSessionManager(handle).getLeafId();
}

export interface PiForkResult {
  readonly sessionId: string;
  readonly sessionPath: string;
}

/**
 * 把源会话从指定叶子（缺省为文件序最后一条）Fork 成全新的独立会话。
 *
 * 实现契约（B0 §3.2 冻结）：在分离的 SessionManager.open(sourceSessionPath)
 * 实例上调用 createBranchedSession —— PI 只新建会话文件（写入源文件同目录、
 * 名为 `<时间戳>_<新会话id>.jsonl`，header.parentSession 指向源文件路径），
 * 并仅替换该分离实例自身的文件/id 状态；源文件内容不受影响。
 * 这里在新文件写入后强制落盘一次（PI 在新路径不含 assistant 消息时会延迟建文件），
 * 保证返回路径上的新会话文件确定存在。源会话没有任何条目时抛 invalid_target；
 * 目标条目不存在时抛 entry_not_found（对应 B0 §3.4 的 404 NOT_FOUND）。
 */
export function forkSessionToNewSession(
  sourceSessionPath: string,
  targetLeafEntryId: string | null,
  cwd: string,
): PiForkResult {
  const manager = SessionManager.open(sourceSessionPath, undefined, cwd);
  if (manager.getEntries().length === 0) {
    throw new PiSessionTreeError("invalid_target", "源会话没有任何条目，无法 Fork 成独立会话");
  }
  const target = targetLeafEntryId ?? manager.getLeafId();
  if (target === null || manager.getEntry(target) === undefined) {
    throw new PiSessionTreeError("entry_not_found", `会话条目不存在：${target === null ? "null" : target}`);
  }
  const newSessionFile = manager.createBranchedSession(target);
  if (newSessionFile === undefined) {
    throw new PiSessionTreeError("invalid_target", "源会话不是持久化会话，无法 Fork 成独立会话");
  }
  flushSessionManagerFile(manager);
  return { sessionId: manager.getSessionId(), sessionPath: newSessionFile };
}

/** 与 handle.persist() 相同的落盘方式（header + 全量条目），保证新文件存在。 */
function flushSessionManagerFile(manager: SessionManager): void {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || !manager.isPersisted()) return;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const header = manager.getHeader();
  const entries = header === null ? manager.getEntries() : [header, ...manager.getEntries()];
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  // 与 wrapSessionManager.persist 一致：已手工落盘后，后续 append 走正常追加路径
  (manager as unknown as { flushed: boolean }).flushed = true;
}
