// ═══════════════════════════════════════════════════════════════
// PI Session JSONL 分支读取器（只读、防御式）
//
// 背景（来自 Phase 10 探索结论）：
// - PI JSONL 第一行是 header {type:"session",version,id,...}，其后每行一个
//   entry {type,id,parentId,timestamp,...}；entry id 仅会话内唯一（8 hex）。
// - 文件没有 branch id/revision，leaf 只存在于 SessionManager 内存；
//   重新打开时 leaf = 文件顺序最后一个 entry。
// - SessionManager.open 遇到截断行会直接抛错；后台 MemoryTicker 必须容忍
//   崩溃截断的最后一行，因此这里用纯 fs 做防御式解析，不经过 SDK。
// - 分支变更判定：cursor 记录的 entry 不再位于当前 leaf→root 路径上。
//
// 本模块是 T3（rolling summary/事件索引）与 T6（recall_session 原文下钻）
// 的共享读取件，只做只读投影，不复制 SessionManager 的写入语义。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";

export interface PiSessionHeaderInfo {
  readonly id: string;
  readonly version: number;
  readonly timestamp: string;
  readonly cwd?: string;
  readonly parentSession?: string;
}

export interface PiJsonlEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  /** 原始 JSON 对象（含 message/customType 等扩展字段） */
  readonly raw: Record<string, unknown>;
}

export interface BranchSnapshot {
  readonly header: PiSessionHeaderInfo | null;
  /** 当前分支路径（root → leaf 顺序） */
  readonly entries: readonly PiJsonlEntry[];
  readonly leafId: string | null;
  /** 全部有效 entry 数（含不在当前分支上的旧分支 entry） */
  readonly totalEntries: number;
  /** 解析失败被丢弃的行数（容忍崩溃截断/半行写入） */
  readonly droppedLines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(raw: Record<string, unknown>): PiSessionHeaderInfo | null {
  if (raw["type"] !== "session") return null;
  if (typeof raw["id"] !== "string" || typeof raw["timestamp"] !== "string") return null;
  const version = typeof raw["version"] === "number" ? raw["version"] : 0;
  return {
    id: raw["id"],
    version,
    timestamp: raw["timestamp"],
    ...(typeof raw["cwd"] === "string" ? { cwd: raw["cwd"] } : {}),
    ...(typeof raw["parentSession"] === "string" ? { parentSession: raw["parentSession"] } : {}),
  };
}

function parseEntry(raw: Record<string, unknown>): PiJsonlEntry | null {
  if (typeof raw["type"] !== "string" || typeof raw["id"] !== "string") return null;
  if (typeof raw["timestamp"] !== "string") return null;
  const parentId = typeof raw["parentId"] === "string" ? raw["parentId"] : null;
  return { type: raw["type"], id: raw["id"], parentId, timestamp: raw["timestamp"], raw };
}

/**
 * 读取 session 文件并还原当前分支。
 * 文件不存在返回 null（未持久化的 session 属正常情况）；
 * 解析失败的行被丢弃并计数，不抛错。
 */
export function readSessionBranchSnapshot(sessionPath: string): BranchSnapshot | null {
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let header: PiSessionHeaderInfo | null = null;
  const allEntries: PiJsonlEntry[] = [];
  let droppedLines = 0;

  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      droppedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      droppedLines += 1;
      continue;
    }
    if (index === 0) {
      const parsedHeader = parseHeader(parsed);
      if (parsedHeader !== null) {
        header = parsedHeader;
        continue;
      }
    }
    const entry = parseEntry(parsed);
    if (entry === null) {
      droppedLines += 1;
      continue;
    }
    allEntries.push(entry);
  }

  // leaf = 文件顺序最后一个 entry（与 SessionManager._buildIndex 一致）
  const leaf = allEntries.length > 0 ? (allEntries[allEntries.length - 1] as PiJsonlEntry) : null;
  const byId = new Map<string, PiJsonlEntry>();
  for (const entry of allEntries) {
    // id 冲突时保留先到者（与 SDK 的碰撞检查语义一致，防御重复行）
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  // leaf → root 走 parentId 链，带环防护
  const path: PiJsonlEntry[] = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor !== null) {
    if (visited.has(cursor.id)) break;
    visited.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId !== null ? (byId.get(cursor.parentId) ?? null) : null;
  }
  path.reverse();

  return {
    header,
    entries: path,
    leafId: leaf?.id ?? null,
    totalEntries: allEntries.length,
    droppedLines,
  };
}

/** entry 是否位于当前分支路径上（分支变更判定：cursor entry 不在路径上即为分支切换） */
export function isEntryOnBranch(snapshot: BranchSnapshot, entryId: string): boolean {
  return snapshot.entries.some((entry) => entry.id === entryId);
}

/**
 * 当前分支上位于 entryId 之后（不含自身）的 entries；
 * entryId 为 null 时返回整个分支。entryId 不在路径上时返回 null（调用方应视为分支变更）。
 */
export function entriesAfterEntry(
  snapshot: BranchSnapshot,
  entryId: string | null,
): readonly PiJsonlEntry[] | null {
  if (entryId === null) return snapshot.entries;
  const index = snapshot.entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return null;
  return snapshot.entries.slice(index + 1);
}

/**
 * 当前分支上 [startId, endId] 闭区间的 entries（recall_session 原文下钻用）。
 * 任一端点不在路径上时返回 null。
 */
export function sliceBranchRange(
  snapshot: BranchSnapshot,
  startId: string,
  endId: string,
): readonly PiJsonlEntry[] | null {
  const start = snapshot.entries.findIndex((entry) => entry.id === startId);
  const end = snapshot.entries.findIndex((entry) => entry.id === endId);
  if (start < 0 || end < 0 || start > end) return null;
  return snapshot.entries.slice(start, end + 1);
}

export interface PiMessageText {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** assistant 消息中的工具调用名列表（统计/摘要上下文用） */
  readonly toolCalls: readonly string[];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block["type"] === "text" && typeof block["text"] === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * 提取 message entry 的纯文本（user/assistant）；非 message 或 toolResult 返回 null。
 * 与 src/pi-sdk/index.ts wrapSessionManager 的提取语义保持一致。
 */
export function extractMessageText(entry: PiJsonlEntry): PiMessageText | null {
  if (entry.type !== "message") return null;
  const message = entry.raw["message"];
  if (!isRecord(message)) return null;
  const role = message["role"];
  if (role !== "user" && role !== "assistant") return null;
  const toolCalls: string[] = [];
  if (Array.isArray(message["content"])) {
    for (const block of message["content"] as unknown[]) {
      if (isRecord(block) && block["type"] === "toolCall" && typeof block["name"] === "string") {
        toolCalls.push(block["name"]);
      }
    }
  }
  return { role, text: extractText(message["content"]), toolCalls };
}
