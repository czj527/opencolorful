import crypto from "node:crypto";
import path from "node:path";

import type {
  MemoryRecallLayer,
  MemoryRecallPayload,
  MemoryRecallStatus,
  MemorySearchHit,
  MemorySearchResult,
  MemoryStrengthTier,
} from "../../contracts/memory.js";
import { type PlatformEventEnvelope, type PlatformEventType } from "../../contracts/events.js";
import type { MemoryFactStore } from "../../storage/memory/fact-store.js";
import type { MemoryEventStore } from "../../storage/memory/event-store.js";
import type { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import type { SessionIndex } from "../../storage/session-index.js";
import { normalizeSearchText } from "../../storage/memory/cjk-ngram.js";
import {
  readSessionBranchSnapshot,
  sliceBranchRange,
  extractMessageText,
} from "./jsonl-branch-reader.js";
import { sanitizeSensitiveText } from "../sanitize.js";

// ═══════════════════════════════════════════════════════════════
// MemoryEventPublisher：per-stream sequence 计数器
// streamId = `agent:${agentId}`，sequence 从 1 递增
//
// 注意：agent 流是跨会话共享的（同 Agent 的所有会话回想事件发布到同一条
// 流），因此序号必须由「流级共享分配器」维护，而不是每个 publisher 实例
// 各自从 0 起计——否则并发/连续回想会产生重复 sequence，破坏
// Last-Event-ID 续传与 Replay 语义。
// ═══════════════════════════════════════════════════════════════

const RECALL_EVENT_TYPE_MAP: Record<MemoryRecallStatus, PlatformEventType> = {
  started: "memory.recall.started",
  layer_changed: "memory.recall.layer_changed",
  completed: "memory.recall.completed",
  empty: "memory.recall.empty",
  failed: "memory.recall.failed",
  cancelled: "memory.recall.cancelled",
};

/** 进程内共享的 agent 流序号（streamId → 已用最大 sequence） */
const agentStreamSequences = new Map<string, number>();

/** 测试用：重置共享序号（单测隔离） */
export function resetAgentStreamSequences(): void {
  agentStreamSequences.clear();
}

/** 取流内下一条单调递增序号（单线程内同步递增，天然无竞争） */
function nextAgentStreamSequence(streamId: string): number {
  const next = (agentStreamSequences.get(streamId) ?? 0) + 1;
  agentStreamSequences.set(streamId, next);
  return next;
}

export class MemoryEventPublisher {
  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly publish: (envelope: PlatformEventEnvelope) => void,
  ) {}

  get streamId(): string {
    return `agent:${this.agentId}`;
  }

  publishRecallEvent(
    type: PlatformEventType,
    payload: MemoryRecallPayload,
  ): void {
    const sequence = nextAgentStreamSequence(this.streamId);
    const envelope: PlatformEventEnvelope = {
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: this.sessionId,
      streamId: this.streamId,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    this.publish(envelope);
  }
}

// ═══════════════════════════════════════════════════════════════
// MemoryRecallService
// ═══════════════════════════════════════════════════════════════

export interface MemoryRecallServiceDeps {
  readonly factStore: MemoryFactStore;
  readonly eventStore: MemoryEventStore;
  readonly recallStore: MemoryRecallStore;
  readonly sessionIndex: SessionIndex;
  readonly publish: (envelope: PlatformEventEnvelope) => void;
  /** agents 根目录，用于路径 inclusion 校验（防穿越） */
  readonly agentsDir: string;
}

export interface MemoryRecallServiceSearchArgs {
  query: string;
  depth?: "quick" | "deep" | "source" | undefined;
  timeRange?: { from?: string; to?: string } | undefined;
  limit?: number | undefined;
}

export type MemoryRecallServiceSearchInput = {
  agentId: string;
  sessionId: string;
  turnId?: string;
  args: MemoryRecallServiceSearchArgs;
  signal?: AbortSignal | undefined;
};

export class MemoryRecallService {
  private readonly factStore: MemoryFactStore;
  private readonly eventStore: MemoryEventStore;
  private readonly recallStore: MemoryRecallStore;
  private readonly sessionIndex: SessionIndex;
  private readonly publish: (envelope: PlatformEventEnvelope) => void;
  private readonly agentsDir: string;

  constructor(deps: MemoryRecallServiceDeps) {
    this.factStore = deps.factStore;
    this.eventStore = deps.eventStore;
    this.recallStore = deps.recallStore;
    this.sessionIndex = deps.sessionIndex;
    this.publish = deps.publish;
    this.agentsDir = deps.agentsDir;
  }

  async search(
    input: MemoryRecallServiceSearchInput,
  ): Promise<MemorySearchResult> {
    const { agentId, sessionId, turnId, args, signal } = input;
    const episodeId = crypto.randomUUID();
    const recallId = crypto.randomUUID();
    const query = args.query;
    const depth = args.depth ?? "quick";
    const limit = args.limit ?? 10;

    const publisher = new MemoryEventPublisher(sessionId, agentId, this.publish);

    function emitAndRecord(
      status: MemoryRecallStatus,
      layer: MemoryRecallLayer | undefined,
      resultCount: number,
    ): void {
      const payload = {
        recallId,
        episodeId,
        agentId,
        sessionId,
        status,
        resultCount,
        ...(turnId ? { turnId } as { turnId: string } : {}),
        ...(layer ? { layer } as { layer: MemoryRecallLayer } : {}),
      } as MemoryRecallPayload;
      publisher.publishRecallEvent(RECALL_EVENT_TYPE_MAP[status], payload);
    }

    function recallEventInput(
      status: MemoryRecallStatus,
      layer: MemoryRecallLayer | undefined,
      resultCount: number,
    ) {
      return {
        episodeId,
        recallId,
        agentId,
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(layer ? { layer } : {}),
        status,
        resultCount,
      };
    }

    try {
      // ── create episode ──────────────────────────────────────
      const now = new Date().toISOString();
      this.recallStore.createEpisode({
        id: episodeId,
        agentId,
        sessionId,
        ...(turnId ? { turnId } : {}),
        status: "started",
        resultCount: 0,
        startedAt: now,
      });
      this.recallStore.appendRecallEvent(recallEventInput("started", undefined, 0));
      emitAndRecord("started", undefined, 0);

      if (signal?.aborted) {
        return this.finishCancelled(episodeId, recallId, agentId, sessionId, turnId, publisher);
      }

      // ── Stage 1: facts ──────────────────────────────────────
      const factHits = this.searchFactsLayer(agentId, sessionId, turnId, recallId, query, limit);

      if (signal?.aborted) {
        return this.finishCancelled(episodeId, recallId, agentId, sessionId, turnId, publisher);
      }

      // quick mode: facts only
      if (depth === "quick") {
        if (factHits.length === 0) {
          return this.finishEmpty(
            episodeId,
            recallId,
            agentId,
            sessionId,
            turnId,
            "facts",
            publisher,
          );
        }
        return this.finishCompleted(
          episodeId,
          recallId,
          agentId,
          sessionId,
          turnId,
          factHits,
          "facts",
          publisher,
        );
      }

      // ── Stage 2: events (deep / source) ──────────────────────
      const needEvents = depth === "source" || factHits.length < 3;
      let eventHits: MemorySearchHit[] = [];

      if (needEvents) {
        this.recallStore.updateEpisode(episodeId, {
          status: "layer_changed",
          resultCount: factHits.length,
        });
        this.recallStore.appendRecallEvent(
          recallEventInput("layer_changed", "events", factHits.length),
        );
        emitAndRecord("layer_changed", "events", factHits.length);

        eventHits = this.searchEventsLayer(
          agentId,
          sessionId,
          turnId,
          recallId,
          query,
          args.timeRange,
          limit,
        );

        if (signal?.aborted) {
          return this.finishCancelled(episodeId, recallId, agentId, sessionId, turnId, publisher);
        }
      }

      // ── Stage 3: source (source mode only) ──────────────────
      let sourceHits: MemorySearchHit[] = [];
      if (depth === "source") {
        const topEvent = eventHits[0];
        if (topEvent) {
          const combinedCount = factHits.length + eventHits.length;
          this.recallStore.updateEpisode(episodeId, {
            status: "layer_changed",
            resultCount: combinedCount,
          });
          this.recallStore.appendRecallEvent(
            recallEventInput("layer_changed", "source", combinedCount),
          );
          emitAndRecord("layer_changed", "source", combinedCount);

          const sourceHit = this.searchSourceLayer(
            agentId,
            sessionId,
            turnId,
            recallId,
            topEvent.targetId,
            this.queryHash(query),
          );
          if (sourceHit) {
            sourceHits = [sourceHit];
          }
        }
      }

      // ── Assemble result ──────────────────────────────────────
      const allHits = [...factHits, ...eventHits, ...sourceHits];

      if (allHits.length === 0) {
        const reachedOnEmpty: MemoryRecallLayer =
          depth === "source" ? "source" : needEvents ? "events" : "facts";
        return this.finishEmpty(
          episodeId,
          recallId,
          agentId,
          sessionId,
          turnId,
          reachedOnEmpty,
          publisher,
        );
      }

      const deepestLayer: MemoryRecallLayer =
        sourceHits.length > 0 ? "source" : eventHits.length > 0 ? "events" : "facts";
      return this.finishCompleted(
        episodeId,
        recallId,
        agentId,
        sessionId,
        turnId,
        allHits,
        deepestLayer,
        publisher,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "回想系统发生未知错误";
      try {
        this.recallStore.updateEpisode(episodeId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
        this.recallStore.appendRecallEvent(
          recallEventInput("failed", undefined, 0),
        );
      } catch {
        // 写入失败本身不掩盖原始错误
      }
      emitAndRecord("failed", undefined, 0);

      return {
        episodeId,
        status: "failed",
        hits: [],
        reachedLayer: "facts",
      };
    }
  }

  // ─── private helpers ─────────────────────────────────────────

  private queryHash(query: string): string {
    return crypto
      .createHash("sha256")
      .update(normalizeSearchText(query))
      .digest("hex")
      .slice(0, 16);
  }

  private strengthTier(retentionStrength: number): MemoryStrengthTier {
    if (retentionStrength < 45) return "short";
    if (retentionStrength < 85) return "medium";
    return "permanent";
  }

  private recallEntryInput(
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    recallId: string,
    targetType: "fact" | "event" | "session",
    targetId: string,
    layer: MemoryRecallLayer,
    queryHash: string,
  ) {
    return {
      agentId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      recallId,
      targetType,
      targetId,
      queryHash,
      layer,
      sourceType: "memory_recall" as const,
    } as const;
  }

  private searchFactsLayer(
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    recallId: string,
    query: string,
    limit: number,
  ): MemorySearchHit[] {
    const facts = this.factStore.searchByFts(agentId, query, limit);
    const qHash = this.queryHash(query);

    return facts.map((fact) => {
      this.recallStore.appendRecall(
        this.recallEntryInput(agentId, sessionId, turnId, recallId, "fact", String(fact.id), "facts", qHash) as Parameters<MemoryRecallStore["appendRecall"]>[0],
      );

      const hit: MemorySearchHit = {
        targetType: "fact",
        targetId: String(fact.id),
        layer: "facts",
        snippet: fact.fact.slice(0, 200),
        provenance: {
          sessionId: fact.sourceRefs[0] ?? "",
        },
        confidence: fact.confidence,
        strengthTier: this.strengthTier(fact.retentionStrength),
        sourceType: "memory_recall",
        ...(fact.factTime ? { validFrom: fact.factTime } : {}),
        ...(fact.validUntil ? { validUntil: fact.validUntil } : {}),
      };

      return hit;
    });
  }

  private searchEventsLayer(
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    recallId: string,
    query: string,
    timeRange: MemoryRecallServiceSearchArgs["timeRange"],
    limit: number,
  ): MemorySearchHit[] {
    const events = this.eventStore.searchByFts(agentId, query, {
      ...(timeRange?.from ? { from: timeRange.from } : {}),
      ...(timeRange?.to ? { to: timeRange.to } : {}),
      limit,
    });
    const qHash = this.queryHash(query);

    return events.map((event) => {
      this.recallStore.appendRecall(
        this.recallEntryInput(agentId, sessionId, turnId, recallId, "event", event.id, "events", qHash) as Parameters<MemoryRecallStore["appendRecall"]>[0],
      );

      const hit: MemorySearchHit = {
        targetType: "event",
        targetId: event.id,
        layer: "events",
        snippet: event.summary.slice(0, 200),
        provenance: {
          sessionId: event.sessionId,
          ...(event.sourceStartEntry
            ? { sourceStartEntry: event.sourceStartEntry }
            : {}),
          ...(event.sourceEndEntry
            ? { sourceEndEntry: event.sourceEndEntry }
            : {}),
        },
        confidence: 0.6,
        sourceType: "memory_recall",
      };

      return hit;
    });
  }

  private searchSourceLayer(
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    recallId: string,
    eventId: string,
    queryHash: string,
  ): MemorySearchHit | undefined {
    const event = this.eventStore.getById(eventId);
    if (!event) return undefined;
    if (!event.sourceStartEntry || !event.sourceEndEntry) return undefined;

    const session = this.sessionIndex.get(event.sessionId);
    if (!session) return undefined;
    if (session.agentId !== agentId) return undefined;

    const sessionPath = path.resolve(session.sessionPath);
    const expectedPrefix = path.resolve(
      path.join(this.agentsDir, agentId, "sessions"),
    );
    if (!sessionPath.startsWith(expectedPrefix + path.sep) && sessionPath !== expectedPrefix) {
      return undefined;
    }

    const snapshot = readSessionBranchSnapshot(sessionPath);
    if (!snapshot) return undefined;

    const slice = sliceBranchRange(
      snapshot,
      event.sourceStartEntry,
      event.sourceEndEntry,
    );
    if (!slice || slice.length === 0) return undefined;

    const texts = slice
      .map((entry) => extractMessageText(entry))
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map((m) => m.text);
    const joined = texts.join("\n");
    const sanitized = sanitizeSensitiveText(joined, 2000);

    // ledger 记录发起回想的会话与查询哈希（与 facts/events 层语义一致）
    this.recallStore.appendRecall(
      this.recallEntryInput(agentId, sessionId, turnId, recallId, "session", event.sessionId, "source", queryHash) as Parameters<MemoryRecallStore["appendRecall"]>[0],
    );

    return {
      targetType: "session",
      targetId: event.sessionId,
      layer: "source",
      snippet: sanitized,
      provenance: {
        sessionId: event.sessionId,
        sourceStartEntry: event.sourceStartEntry,
        sourceEndEntry: event.sourceEndEntry,
      },
      confidence: 0.6,
      sourceType: "memory_recall",
    };
  }

  private finishCompleted(
    episodeId: string,
    recallId: string,
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    hits: readonly MemorySearchHit[],
    reachedLayer: MemoryRecallLayer,
    publisher: MemoryEventPublisher,
  ): MemorySearchResult {
    const now = new Date().toISOString();
    try {
      this.recallStore.updateEpisode(episodeId, {
        status: "completed",
        resultCount: hits.length,
        completedAt: now,
      });
      this.recallStore.appendRecallEvent({
        episodeId,
        recallId,
        agentId,
        sessionId,
        ...(turnId ? { turnId } : {}),
        status: "completed",
        resultCount: hits.length,
      });
    } catch {
      // best-effort
    }
    const payload = {
      recallId,
      episodeId,
      agentId,
      sessionId,
      status: "completed" as const,
      resultCount: hits.length,
      ...(turnId ? { turnId } as { turnId: string } : {}),
    } as MemoryRecallPayload;
    publisher.publishRecallEvent("memory.recall.completed", payload);

    return {
      episodeId,
      status: "completed",
      hits,
      reachedLayer,
    };
  }

  private finishEmpty(
    episodeId: string,
    recallId: string,
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    reachedLayer: MemoryRecallLayer,
    publisher: MemoryEventPublisher,
  ): MemorySearchResult {
    const now = new Date().toISOString();
    try {
      this.recallStore.updateEpisode(episodeId, {
        status: "empty",
        resultCount: 0,
        completedAt: now,
      });
      this.recallStore.appendRecallEvent({
        episodeId,
        recallId,
        agentId,
        sessionId,
        ...(turnId ? { turnId } : {}),
        status: "empty",
        resultCount: 0,
      });
    } catch {
      // best-effort
    }
    const payload = {
      recallId,
      episodeId,
      agentId,
      sessionId,
      status: "empty" as const,
      resultCount: 0,
      ...(turnId ? { turnId } as { turnId: string } : {}),
    } as MemoryRecallPayload;
    publisher.publishRecallEvent("memory.recall.empty", payload);

    return {
      episodeId,
      status: "empty",
      hits: [],
      reachedLayer,
    };
  }

  private finishCancelled(
    episodeId: string,
    recallId: string,
    agentId: string,
    sessionId: string,
    turnId: string | undefined,
    publisher: MemoryEventPublisher,
  ): MemorySearchResult {
    const now = new Date().toISOString();
    try {
      this.recallStore.updateEpisode(episodeId, {
        status: "cancelled",
        completedAt: now,
      });
      this.recallStore.appendRecallEvent({
        episodeId,
        recallId,
        agentId,
        sessionId,
        ...(turnId ? { turnId } : {}),
        status: "cancelled",
        resultCount: 0,
      });
    } catch {
      // best-effort
    }
    const payload = {
      recallId,
      episodeId,
      agentId,
      sessionId,
      status: "cancelled" as const,
      resultCount: 0,
      ...(turnId ? { turnId } as { turnId: string } : {}),
    } as MemoryRecallPayload;
    publisher.publishRecallEvent("memory.recall.cancelled", payload);

    return {
      episodeId,
      status: "cancelled",
      hits: [],
      reachedLayer: "facts",
    };
  }
}
