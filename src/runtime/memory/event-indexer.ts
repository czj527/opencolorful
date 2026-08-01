// ═══════════════════════════════════════════════════════════════
// 事件索引器（plans/phase-10.md 第五节 T3）
//
// 从 session summary + JSONL branch 范围生成 memory_events 行。
// 不额外调用 LLM：时间线文本来自 summary，topics 规则提取，
// 统计字段从 sliceBranchRange 确定性计算。
// LLM 不可用时仍可产出 deterministic stub。
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";

import type { SessionSummary } from "../../contracts/memory.js";
import type { MemoryEventStore } from "../../storage/memory/event-store.js";
import type { MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import { buildMemorySearchText } from "../../storage/memory/cjk-ngram.js";
import type { PiJsonlEntry } from "./jsonl-branch-reader.js";
import {
  extractMessageText,
  readSessionBranchSnapshot,
  sliceBranchRange,
} from "./jsonl-branch-reader.js";
import { extractSummarySection } from "./summary-format.js";
import { sanitizeSensitiveText } from "../sanitize.js";

// ─── Types ───────────────────────────────────────────────────────

export interface EventIndexerDeps {
  eventStore: MemoryEventStore;
  watermarkStore: MemoryWatermarkStore;
}

export type EventIndexResult =
  | {
      status: "indexed" | "degraded";
      eventId: string;
      alreadyIndexed?: boolean;
    }
  | { status: "skipped"; reason: string };

// ─── Helpers ─────────────────────────────────────────────────────

function computeEventId(
  sessionId: string,
  branchRevision: string,
  startEntryId: string,
  endEntryId: string,
): string {
  const hash = crypto.createHash("sha256");
  hash.update(sessionId);
  hash.update(branchRevision);
  hash.update(startEntryId);
  hash.update(endEntryId);
  return "ev_" + hash.digest("hex").slice(0, 16);
}

function firstEntryTimestamp(entries: readonly PiJsonlEntry[]): string {
  return entries[0]!.timestamp;
}

function lastEntryTimestamp(entries: readonly PiJsonlEntry[]): string {
  return entries[entries.length - 1]!.timestamp;
}

function toLocalDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** CJK 2-gram 高频词提取（>=2 次） */
function extractFrequentCjkBigrams(text: string): string[] {
  const cjkRunRe =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  const freq = new Map<string, number>();
  for (const match of text.matchAll(cjkRunRe)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i <= chars.length - 2; i += 1) {
      const bigram = chars.slice(i, i + 2).join("");
      freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([word]) => word);
}

/** 英文大写/技术词 */
const TECH_WORD_RE = /\b[A-Z][A-Z0-9_]{1,}\b/g;

function extractTechWords(text: string): string[] {
  const words = new Set<string>();
  for (const match of text.matchAll(TECH_WORD_RE)) {
    words.add(match[0]);
  }
  return [...words];
}

/** 从 summary 文本中规则提取 topics（去重取前 8） */
function extractTopics(
  summaryText: string,
  toolNames: readonly string[],
): readonly string[] {
  const cjkBigrams = extractFrequentCjkBigrams(summaryText);
  const techWords = extractTechWords(summaryText);
  const all = [...new Set([...cjkBigrams, ...toolNames, ...techWords])];
  return all.slice(0, 8);
}

/** 构建 deterministic stub summary */
function buildStubSummary(
  entries: readonly PiJsonlEntry[],
): {
  summary: string;
  topics: readonly string[];
} {
  const messages = entries
    .map((e) => extractMessageText(e))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const toolCallsTotal = messages.reduce(
    (sum, m) => sum + m.toolCalls.length,
    0,
  );

  const allToolNames = new Set<string>();
  for (const m of messages) {
    for (const t of m.toolCalls) {
      allToolNames.add(t);
    }
  }

  // 第一条 user 消息摘录（≤120 字，脱敏）
  const firstUser = messages.find((m) => m.role === "user");
  const excerpt = firstUser
    ? sanitizeSensitiveText(firstUser.text).slice(0, 120)
    : "（无用户消息）";

  const summary = `${excerpt}\n\n[自动摘要] 共 ${userCount + assistantCount} 条消息（用户 ${userCount}，助手 ${assistantCount}），${toolCallsTotal} 次工具调用。`;

  return {
    summary,
    topics: [...allToolNames],
  };
}

// ─── Indexer ─────────────────────────────────────────────────────

export class EventIndexer {
  private readonly eventStore: MemoryEventStore;
  private readonly watermarkStore: MemoryWatermarkStore;

  constructor(deps: EventIndexerDeps) {
    this.eventStore = deps.eventStore;
    this.watermarkStore = deps.watermarkStore;
  }

  indexSession(input: {
    agentId: string;
    sessionId: string;
    sessionPath: string;
    summary?: SessionSummary;
  }): EventIndexResult {
    const { agentId, sessionId, sessionPath, summary } = input;

    const snapshot = readSessionBranchSnapshot(sessionPath);
    if (snapshot === null) {
      return { status: "skipped", reason: "session 未持久化" };
    }

    // 确定 source range
    const branchRevision =
      summary?.branchRevision ??
      crypto
        .createHash("sha256")
        .update(snapshot.entries.map((e) => e.id).join(":"))
        .digest("hex")
        .slice(0, 16);

    const sStart =
      summary?.sourceStartEntry ?? snapshot.entries[0]?.id;
    const sEnd =
      summary?.sourceEndEntry ??
      snapshot.entries[snapshot.entries.length - 1]?.id;

    if (sStart === undefined || sEnd === undefined) {
      return { status: "skipped", reason: "无法确定 source range" };
    }

    const rangeEntries = sliceBranchRange(snapshot, sStart, sEnd);
    if (rangeEntries === null) {
      return { status: "skipped", reason: "source range 不在当前分支上" };
    }

    const eventId = computeEventId(sessionId, branchRevision, sStart, sEnd);

    // 收集统计
    const messages = rangeEntries
      .map((e) => extractMessageText(e))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const messageCount = messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    ).length;
    const toolCalls = messages.reduce((sum, m) => sum + m.toolCalls.length, 0);
    const date = toLocalDate(firstEntryTimestamp(rangeEntries));
    const startedAt = firstEntryTimestamp(rangeEntries);
    const endedAt = lastEntryTimestamp(rangeEntries);

    const firstMs = new Date(startedAt).getTime();
    const lastMs = new Date(endedAt).getTime();
    const durationSec = Math.max(0, Math.round((lastMs - firstMs) / 1000));

    // 确定 summary 文本与 topics
    let eventSummary: string;
    let topics: readonly string[];

    if (
      summary !== undefined &&
      summary.summary.length > 0
    ) {
      // 正常路径：summary 的时间线节作为事件 summary
      const timeline = extractSummarySection(summary.summary, "timeline");
      const facts = extractSummarySection(summary.summary, "facts");

      // 收集范围内所有工具名
      const allToolNames = new Set<string>();
      for (const m of messages) {
        for (const t of m.toolCalls) {
          allToolNames.add(t);
        }
      }

      eventSummary = timeline || facts || summary.summary.slice(0, 500);
      topics = extractTopics(
        summary.summary,
        [...allToolNames],
      );
    } else {
      // deterministic stub
      const stub = buildStubSummary(rangeEntries);
      eventSummary = stub.summary;
      topics = stub.topics;
    }

    const searchText = buildMemorySearchText(eventSummary, topics.join(" "));

    const inserted = this.eventStore.insertEvent({
      id: eventId,
      agentId,
      sessionId,
      branchRevision,
      sourceStartEntry: sStart,
      sourceEndEntry: sEnd,
      date,
      startedAt,
      endedAt,
      summary: eventSummary,
      topics,
      searchText,
      messageCount,
      toolCalls,
      durationSec,
      status: "active",
    });

    // 只有正常 summary 路径才推进为 clean；deterministic stub 仍可检索，
    // 但保留 dirty 标记，便于后续 LLM 可用时重新整理。
    this.watermarkStore.upsert(
      agentId,
      "events",
      branchRevision,
      { lastEntryId: sEnd },
      summary !== undefined && summary.summary.length > 0 ? false : true,
    );

    if (summary !== undefined && summary.summary.length > 0) {
      return {
        status: "indexed",
        eventId,
        alreadyIndexed: !inserted,
      };
    }

    return {
      status: "degraded",
      eventId,
      alreadyIndexed: !inserted,
    };
  }
}
