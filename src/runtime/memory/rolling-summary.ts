// ═══════════════════════════════════════════════════════════════
// Rolling Summary Service（plans/phase-10.md 第五节 T3）
//
// 基于 PI JSONL branch cursor 的增量 rolling summary 生成器。
// 以 openColorful 的 entry ID + branch revision 作为稳定身份，
// 支持增量/全量/分支变更三种模式，LLM 失败时降级不退游标。
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";

import type { SessionSummary } from "../../contracts/memory.js";
import type { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import type { MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import {
  entriesAfterEntry,
  extractMessageText,
  readSessionBranchSnapshot,
  type BranchSnapshot,
  type PiMessageText,
} from "./jsonl-branch-reader.js";
import type { PiJsonlEntry } from "./jsonl-branch-reader.js";
import { validateSummaryFormat } from "./summary-format.js";
import {
  buildRepairPrompt,
  buildRollingSummaryPrompt,
} from "./summary-prompts.js";
import { sanitizeSensitiveText } from "../sanitize.js";
import { instrument } from "../../observability/instrument.js";

// ─── Types ───────────────────────────────────────────────────────

export interface RollingSummaryDeps {
  summaryStore: SessionSummaryStore;
  watermarkStore: MemoryWatermarkStore;
  /**
   * 注入的 LLM 调用函数。undefined 表示 LLM 不可用（degraded 路径）。
   * 测试时可注入假实现。
   */
  completeText?: (req: {
    systemPrompt: string;
    prompt: string;
    maxTokens?: number;
  }) => Promise<string>;
  /** 单次处理的最大消息数，默认 200，防超长 */
  maxMessagesPerPass?: number;
}

export type SummaryRunResult =
  | { status: "updated"; branchRevision: string; messageCount: number }
  | { status: "skipped"; reason: string }
  | { status: "failed" | "degraded"; reason: string };

// ─── Helpers ─────────────────────────────────────────────────────

function computeBranchRevision(entries: readonly PiJsonlEntry[]): string {
  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.id);
    hash.update(":");
  }
  return hash.digest("hex").slice(0, 16);
}

function lastEntryId(entries: readonly PiJsonlEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  // safe: entries.length > 0
  return entries[entries.length - 1]!.id;
}

function firstEntryId(entries: readonly PiJsonlEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries[0]!.id;
}

function entriesTimestampRange(
  entries: readonly PiJsonlEntry[],
): { first: number; last: number } | null {
  if (entries.length === 0) return null;
  const first = new Date(entries[0]!.timestamp).getTime();
  const last = new Date(entries[entries.length - 1]!.timestamp).getTime();
  return { first, last };
}

/** 过滤出 user/assistant 消息，返回文本与统计信息 */
function filterMessages(
  entries: readonly PiJsonlEntry[],
): readonly PiMessageText[] {
  const results: PiMessageText[] = [];
  for (const entry of entries) {
    const msg = extractMessageText(entry);
    if (msg !== null) results.push(msg);
  }
  return results;
}

const MAX_TOKENS = 4096;

// ─── Service ─────────────────────────────────────────────────────

export class RollingSummaryService {
  private readonly summaryStore: SessionSummaryStore;
  private readonly watermarkStore: MemoryWatermarkStore;
  private readonly completeText:
    | ((
        req: {
          systemPrompt: string;
          prompt: string;
          maxTokens?: number;
        },
      ) => Promise<string>)
    | undefined;
  private readonly maxMessagesPerPass: number;

  constructor(deps: RollingSummaryDeps) {
    this.summaryStore = deps.summaryStore;
    this.watermarkStore = deps.watermarkStore;
    this.completeText = deps.completeText;
    this.maxMessagesPerPass = deps.maxMessagesPerPass ?? 200;
  }

  async maybeSummarize(input: {
    agentId: string;
    sessionId: string;
    sessionPath: string;
  }): Promise<SummaryRunResult> {
    // Phase 11 T5：一次摘要 run = 一个 operation（后台 trace 由调用方 runAsBackground 提供）
    const lifecycle = instrument.startLifecycle({
      startEventName: "memory.summary.started",
      actor: { kind: "scheduler", id: "memory-ticker" },
      executor: { kind: "memory_agent", id: input.agentId },
      scope: { ownerAgentId: input.agentId, sessionId: input.sessionId },
      operationId: `summary-${input.agentId}-${input.sessionId}-${crypto.randomUUID().slice(0, 8)}`,
      terminals: {
        completed: "memory.summary.completed",
        degraded: "memory.summary.degraded",
        failed: "memory.summary.failed",
      },
    });
    const result = await this.maybeSummarizeInner(input);
    if (result.status === "failed") {
      lifecycle.fail(result.reason);
    } else if (result.status === "degraded") {
      lifecycle.degraded(result.reason);
    } else {
      // updated / skipped 均为正常完成（skipped 附原因）
      lifecycle.complete({
        ...(result.status === "updated" ? { attributes: { branchRevision: result.branchRevision, messageCount: result.messageCount } } : {}),
        ...(result.status === "skipped" ? { attributes: { skipped: result.reason } } : {}),
      });
    }
    return result;
  }

  private async maybeSummarizeInner(input: {
    agentId: string;
    sessionId: string;
    sessionPath: string;
  }): Promise<SummaryRunResult> {
    const { agentId, sessionId, sessionPath } = input;

    // ── a. snapshot null → skipped ──
    const snapshot = readSessionBranchSnapshot(sessionPath);
    if (snapshot === null) {
      return { status: "skipped", reason: "session 未持久化" };
    }

    // ── b. 查已有 summary row ──
    const existing = this.summaryStore.getLatestForSession(sessionId);

    let branchRevision: string;
    let messagesToProcess: readonly PiMessageText[];
    let sourceEntries: readonly PiJsonlEntry[];
    let previousSummary: string | undefined;

    if (existing === undefined) {
      // ── c. 无 row → 初始全量摘要 ──
      branchRevision = computeBranchRevision(snapshot.entries);
      sourceEntries = snapshot.entries;
      previousSummary = undefined;
    } else {
      // ── d. 有 row → 增量 / 分支变更判定 ──
      const cursorEntryId =
        existing.cursor["lastEntryId"] !== undefined &&
        typeof existing.cursor["lastEntryId"] === "string"
          ? existing.cursor["lastEntryId"]
          : null;

      const afterEntries = entriesAfterEntry(snapshot, cursorEntryId);

      if (afterEntries === null) {
        // 分支变更：cursor entry 不再位于当前路径
        branchRevision = computeBranchRevision(snapshot.entries);
        sourceEntries = snapshot.entries;
        previousSummary = existing.summary;
      } else if (afterEntries.length === 0) {
        return { status: "skipped", reason: "无新消息" };
      } else {
        branchRevision = existing.branchRevision;
        sourceEntries = afterEntries;
        previousSummary = existing.summary;
      }
    }

    // 过滤消息并应用截断
    messagesToProcess = filterMessages(sourceEntries);

    if (messagesToProcess.length === 0) {
      return { status: "skipped", reason: "当前范围无可摘要消息" };
    }

    const truncated = messagesToProcess.length > this.maxMessagesPerPass;
    if (truncated) {
      messagesToProcess = messagesToProcess.slice(-this.maxMessagesPerPass);
    }

    // ── e. completeText undefined → degraded ──
    if (this.completeText === undefined) {
      this.watermarkStore.upsert(
        agentId,
        "summary",
        branchRevision,
        {},
        true,
      );
      return { status: "degraded", reason: "LLM 不可用" };
    }

    // ── f/g/h. LLM 调用 → 格式校验 → repair → 落盘 ──
    try {
      const { systemPrompt, prompt } = buildRollingSummaryPrompt({
        ...(previousSummary !== undefined ? { previousSummary } : {}),
        newMessages: truncated
          ? messagesToProcess.map((m) => {
              const toolStr =
                m.toolCalls.length > 0
                  ? ` [工具: ${m.toolCalls.join(", ")}]`
                  : "";
              return {
                ...m,
                text: `[截断处理，仅展示最近 ${this.maxMessagesPerPass} 条消息] ${m.text}${toolStr}`,
              };
            })
          : messagesToProcess,
      });

      let rawOutput = await this.completeText({
        systemPrompt,
        prompt,
        maxTokens: MAX_TOKENS,
      });

      // 格式校验
      let validation = validateSummaryFormat(rawOutput);

      // 失败 → repair once
      if (!validation.ok) {
        const repairInput = buildRepairPrompt({
          previousOutput: rawOutput,
          missing: validation.missing,
        });

        rawOutput = await this.completeText({
          systemPrompt: repairInput.systemPrompt,
          prompt: repairInput.prompt,
          maxTokens: MAX_TOKENS,
        });

        validation = validateSummaryFormat(rawOutput);
      }

      // repair 后仍失败
      if (!validation.ok) {
        this.watermarkStore.upsert(
          agentId,
          "summary",
          branchRevision,
          existing?.cursor ?? {},
          true,
        );
        return {
          status: "failed",
          reason: `格式校验失败，缺失: ${validation.missing.join(", ")}；repair 未能修复`,
        };
      }

      // ── g. 成功 → 脱敏并落盘 ──
      const sanitized = sanitizeSensitiveText(rawOutput);

      const sStart = firstEntryId(sourceEntries);
      const sEnd = lastEntryId(sourceEntries);
      const cursorLastId = lastEntryId(sourceEntries);

      if (cursorLastId === undefined) {
        return { status: "skipped", reason: "处理后无可推进的 cursor" };
      }

      const cursor = { lastEntryId: cursorLastId };

      this.summaryStore.upsert({
        sessionId,
        branchRevision,
        agentId,
        summary: sanitized,
        messageCount: messagesToProcess.length,
        cursor,
        ...(sStart !== undefined ? { sourceStartEntry: sStart } : {}),
        ...(sEnd !== undefined ? { sourceEndEntry: sEnd } : {}),
      });

      this.watermarkStore.upsert(
        agentId,
        "summary",
        branchRevision,
        cursor,
        false,
      );

      return {
        status: "updated",
        branchRevision,
        messageCount: messagesToProcess.length,
      };
    } catch (error) {
      // ── h. completeText 抛错 → failed ──
      this.watermarkStore.upsert(
        agentId,
        "summary",
        branchRevision,
        existing?.cursor ?? {},
        true,
      );
      return {
        status: "failed",
        reason: `LLM 调用异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
