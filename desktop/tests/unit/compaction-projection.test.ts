/**
 * 波次 B4 · L5 单测（无渲染）：压缩卡投影矩阵（§3.2.4 冻结分态）。
 * - compacting → 进行中卡；compacted 配对同 id → completed / aborted / failed
 * - 无先导 compacting 的 compacted（replay 场景）独立成卡
 * - seedItems 重置进行中压缩；projectBranchEntries 历史 compaction 条目 → 同构 completed 卡
 * 渲染层在 src/compaction-card.mock.test.tsx。
 */
import { describe, expect, it } from "vitest";

import { applyEvent, createProjector, projectBranchEntries, seedItems, type BranchEntry, type LiveEnvelope } from "../../src/data/projector.js";
import type { CompactionItem } from "../../src/mock-data.js";

const SHORT_SUMMARY = "主题令牌已收敛为语义层。";

function envelope(type: string, payload: Record<string, unknown>, streamId = "ctrl-x", sequence = 1): LiveEnvelope {
  return {
    protocolVersion: 1,
    eventId: `ev-${type}-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "s1",
    streamId,
    sequence,
    timestamp: "2026-09-05T10:00:00+08:00",
    type,
    payload,
  } as LiveEnvelope;
}

function itemsByType(state: ReturnType<typeof createProjector>): CompactionItem[] {
  return state.items.filter((item): item is CompactionItem => item.type === "compaction");
}

function firstCard(state: ReturnType<typeof createProjector>): CompactionItem {
  const [card] = itemsByType(state);
  if (card === undefined) throw new Error("expected a compaction card");
  return card;
}

function compactionEntry(partial: Partial<BranchEntry> & Pick<BranchEntry, "entryId">): BranchEntry {
  return { parentId: null, turnId: null, type: "compaction", text: "", timestamp: "2026-09-05T09:00:00+08:00", ...partial };
}

describe("projector 压缩卡矩阵", () => {
  it("compacting → 进行中卡（无正文）；compacted → 配对同 id 的 completed 卡（tokens+summary）", () => {
    const state = createProjector("原");
    applyEvent(state, envelope("session.compacting", { reason: "manual" }, "ctrl-x", 1));
    const inFlight = firstCard(state);
    expect(inFlight.status).toBe("compacting");
    expect(inFlight.summary).toBeUndefined();
    expect(state.activeCompactionId).toBe(inFlight.id);

    applyEvent(state, envelope("session.compacted", {
      reason: "manual", aborted: false, tokensBefore: 39200, tokensAfter: 18600, summary: SHORT_SUMMARY,
    }, "ctrl-x", 2));
    const card = firstCard(state);
    expect(card.id).toBe(inFlight.id);
    expect(card.status).toBe("completed");
    expect(card.summary).toBe(SHORT_SUMMARY);
    expect(card.tokensBefore).toBe(39200);
    expect(card.tokensAfter).toBe(18600);
    expect(state.activeCompactionId).toBeNull();
  });

  it("aborted（无错误）与 failed（含错误）分态可区分", () => {
    const state = createProjector("原");
    applyEvent(state, envelope("session.compacting", { reason: "manual" }, "ctrl-x", 1));
    applyEvent(state, envelope("session.compacted", { reason: "manual", aborted: true }, "ctrl-x", 2));
    expect(firstCard(state).status).toBe("aborted");

    const state2 = createProjector("原");
    applyEvent(state2, envelope("session.compacting", { reason: "manual" }, "ctrl-y", 1));
    applyEvent(state2, envelope("session.compacted", { reason: "manual", aborted: false, errorMessage: "压缩失败：模型不可用" }, "ctrl-y", 2));
    const card = firstCard(state2);
    expect(card.status).toBe("failed");
    expect(card.errorMessage).toBe("压缩失败：模型不可用");
  });

  it("无先导 compacting 的 compacted（replay 场景）→ 独立成卡", () => {
    const state = createProjector("原");
    applyEvent(state, envelope("session.compacted", {
      reason: "threshold", aborted: false, tokensBefore: 100, tokensAfter: 40, summary: SHORT_SUMMARY,
    }, "ctrl-z", 1));
    const card = firstCard(state);
    expect(card.status).toBe("completed");
    expect(card.id.startsWith("compaction-")).toBe(true);
  });

  it("seedItems 重置进行中压缩状态；历史 compaction 条目投影为同构 completed 卡", () => {
    const state = createProjector("原");
    applyEvent(state, envelope("session.compacting", { reason: "manual" }, "ctrl-x", 1));
    seedItems(state, []);
    expect(state.activeCompactionId).toBeNull();

    const items = projectBranchEntries([
      compactionEntry({ entryId: "e-c1", text: SHORT_SUMMARY }),
    ], "原");
    expect(items).toHaveLength(1);
    const card = items[0] as CompactionItem;
    expect(card).toMatchObject({ id: "compaction-e-c1", type: "compaction", status: "completed", summary: SHORT_SUMMARY });
  });
});
