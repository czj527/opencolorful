import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  ForgetIntentArgsSchema,
  MEMORY_BATCH_STATUSES,
  MEMORY_DAILY_STEPS,
  MEMORY_FACT_SOURCES,
  MEMORY_FACT_STATUSES,
  MEMORY_JOURNAL_ACTORS,
  MEMORY_JOURNAL_INTENT_TYPES,
  MEMORY_JOURNAL_STATUSES,
  MEMORY_JOURNAL_TARGET_TYPES,
  MEMORY_RECALL_LAYERS,
  MEMORY_RECALL_STATUSES,
  MEMORY_SCHEDULER_STATUSES,
  MEMORY_SEARCH_DEPTHS,
  MEMORY_STRENGTH_TIERS,
  MEMORY_WATERMARK_SCOPES,
  MemoryRecallPayloadSchema,
  MemoryUpdatedPayloadSchema,
  NON_EVIDENCE_SOURCE_TYPES,
  PinMemoryArgsSchema,
  RememberIntentArgsSchema,
  SearchMemoryArgsSchema,
  STRENGTH_MAX,
  STRENGTH_MIN,
  UnpinMemoryArgsSchema,
} from "../../src/contracts/memory.js";
import { EVENT_TYPES } from "../../src/contracts/events.js";

describe("memory contract enums", () => {
  it("recall layers follow drill-down order facts → events → source", () => {
    expect(MEMORY_RECALL_LAYERS).toEqual(["facts", "events", "source"]);
  });

  it("recall statuses cover the full episode lifecycle", () => {
    expect(MEMORY_RECALL_STATUSES).toEqual([
      "started",
      "layer_changed",
      "completed",
      "empty",
      "failed",
      "cancelled",
    ]);
  });

  it("daily steps follow the openhanako conveyor order S0-S4", () => {
    expect(MEMORY_DAILY_STEPS).toEqual(["S0", "S1", "S2", "S3", "S4"]);
  });

  it("strength tiers and bounds", () => {
    expect(MEMORY_STRENGTH_TIERS).toEqual(["short", "medium", "permanent"]);
    expect(STRENGTH_MIN).toBe(0);
    expect(STRENGTH_MAX).toBe(100);
  });

  it("fact statuses/sources match migration v6 CHECK constraints", () => {
    expect(MEMORY_FACT_STATUSES).toEqual(["active", "forgotten", "superseded", "suppressed"]);
    expect(MEMORY_FACT_SOURCES).toEqual(["agent_proposed", "agent_approved", "user_intent"]);
  });

  it("journal enums match migration v6 CHECK constraints", () => {
    expect(MEMORY_JOURNAL_ACTORS).toEqual(["user", "main_agent", "memory_agent", "system"]);
    expect(MEMORY_JOURNAL_INTENT_TYPES).toEqual([
      "remember",
      "forget",
      "pin",
      "unpin",
      "supersede",
      "merge",
      "suppress",
      "restore",
    ]);
    expect(MEMORY_JOURNAL_TARGET_TYPES).toEqual(["fact", "event", "session", "memory"]);
    expect(MEMORY_JOURNAL_STATUSES).toEqual([
      "pending",
      "approved",
      "rejected",
      "applied",
      "revoked",
    ]);
  });

  it("batch statuses match migration v6 CHECK constraints", () => {
    expect(MEMORY_BATCH_STATUSES).toEqual([
      "provisional",
      "sealed",
      "processing",
      "applied",
      "deferred",
      "failed",
    ]);
  });

  it("watermark scopes and scheduler statuses match migration v6", () => {
    expect(MEMORY_WATERMARK_SCOPES).toEqual(["summary", "events", "markdown", "batch"]);
    expect(MEMORY_SCHEDULER_STATUSES).toEqual(["idle", "running", "deferred", "failed"]);
  });

  it("recall/injection/paraphrase are excluded from reinforcement evidence", () => {
    expect(NON_EVIDENCE_SOURCE_TYPES).toContain("memory_recall");
    expect(NON_EVIDENCE_SOURCE_TYPES).toContain("injected_memory");
    expect(NON_EVIDENCE_SOURCE_TYPES).toContain("agent_paraphrase");
    expect(NON_EVIDENCE_SOURCE_TYPES).not.toContain("original");
  });
});

describe("memory SSE event types", () => {
  it("registers memory.updated and the full memory.recall.* family", () => {
    for (const type of [
      "memory.updated",
      "memory.recall.started",
      "memory.recall.layer_changed",
      "memory.recall.completed",
      "memory.recall.empty",
      "memory.recall.failed",
      "memory.recall.cancelled",
    ]) {
      expect(EVENT_TYPES).toContain(type);
    }
  });
});

describe("SearchMemoryArgsSchema", () => {
  it("accepts a minimal query", () => {
    expect(Value.Check(SearchMemoryArgsSchema, { query: "部署决定" })).toBe(true);
  });

  it("accepts full arguments", () => {
    expect(
      Value.Check(SearchMemoryArgsSchema, {
        query: "偏好",
        depth: "deep",
        timeRange: { from: "2026-07-01", to: "2026-07-31" },
        limit: 20,
      }),
    ).toBe(true);
  });

  it("rejects empty query and invalid depth/limit", () => {
    expect(Value.Check(SearchMemoryArgsSchema, { query: "" })).toBe(false);
    expect(Value.Check(SearchMemoryArgsSchema, { query: "x", depth: "forever" })).toBe(false);
    expect(Value.Check(SearchMemoryArgsSchema, { query: "x", limit: 0 })).toBe(false);
  });

  it("search depths are quick/deep/source", () => {
    expect(MEMORY_SEARCH_DEPTHS).toEqual(["quick", "deep", "source"]);
  });
});

describe("intent tool arg schemas", () => {
  it("remember requires a non-empty fact", () => {
    expect(Value.Check(RememberIntentArgsSchema, { fact: "用户偏好深色模式" })).toBe(true);
    expect(Value.Check(RememberIntentArgsSchema, { fact: "" })).toBe(false);
    expect(
      Value.Check(RememberIntentArgsSchema, {
        fact: "f",
        tags: ["偏好"],
        validUntil: "2027-01-01",
      }),
    ).toBe(true);
  });

  it("forget requires a valid target type", () => {
    expect(Value.Check(ForgetIntentArgsSchema, { targetType: "fact", targetId: "1" })).toBe(true);
    expect(Value.Check(ForgetIntentArgsSchema, { targetType: "memory" })).toBe(false);
  });

  it("pin/unpin validate their arguments", () => {
    expect(Value.Check(PinMemoryArgsSchema, { content: "常用部署命令" })).toBe(true);
    expect(Value.Check(PinMemoryArgsSchema, { content: "" })).toBe(false);
    expect(Value.Check(UnpinMemoryArgsSchema, { id: "pin_1" })).toBe(true);
    expect(Value.Check(UnpinMemoryArgsSchema, {})).toBe(false);
  });
});

describe("memory SSE payload schemas", () => {
  it("memory.updated payload", () => {
    expect(Value.Check(MemoryUpdatedPayloadSchema, { agentId: "a1" })).toBe(true);
    expect(Value.Check(MemoryUpdatedPayloadSchema, { agentId: "a1", revision: "r3" })).toBe(true);
    expect(Value.Check(MemoryUpdatedPayloadSchema, {})).toBe(false);
  });

  it("memory.recall.* payload", () => {
    expect(
      Value.Check(MemoryRecallPayloadSchema, {
        recallId: "r1",
        episodeId: "e1",
        agentId: "a1",
        sessionId: "s1",
        status: "started",
      }),
    ).toBe(true);
    expect(
      Value.Check(MemoryRecallPayloadSchema, {
        recallId: "r1",
        episodeId: "e1",
        agentId: "a1",
        sessionId: "s1",
        turnId: "t1",
        layer: "events",
        status: "layer_changed",
        resultCount: 3,
      }),
    ).toBe(true);
    expect(
      Value.Check(MemoryRecallPayloadSchema, {
        recallId: "r1",
        episodeId: "e1",
        agentId: "a1",
        sessionId: "s1",
        status: "exploding",
      }),
    ).toBe(false);
  });
});
