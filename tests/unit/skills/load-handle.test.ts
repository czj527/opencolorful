import { beforeEach, describe, expect, it } from "vitest";

import type { SkillRef } from "../../../src/contracts/skill-protocol.js";
import { LoadHandleRegistry } from "../../../src/runtime/skills/content/load-handle.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 loadHandle 单元测试（tests/unit/skills/）
// ═══════════════════════════════════════════════════════════════

describe("LoadHandleRegistry", () => {
  let registry: LoadHandleRegistry;
  let nowValue: Date;

  const skillRef: SkillRef = {
    skillId: "alpha",
    sourceId: "src-managed",
    sourceKind: "managed",
    version: "1.0.0",
    contentHash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  beforeEach(() => {
    nowValue = new Date("2026-01-01T00:00:00.000Z");
    registry = new LoadHandleRegistry({ now: () => nowValue });
  });

  function issue(overrides: Partial<{ turnId: string; sessionId: string; ttlMs: number }> = {}) {
    return registry.issueLoadHandle({
      turnId: overrides.turnId ?? "turn-1",
      sessionId: overrides.sessionId ?? "session-1",
      skillRef,
      contentHash: skillRef.contentHash,
      ttlMs: overrides.ttlMs ?? 60_000,
    });
  }

  it("签发：字段完整、未消费、TTL 正确", () => {
    const handle = issue();
    expect(handle.handleId.startsWith("load-")).toBe(true);
    expect(handle.turnId).toBe("turn-1");
    expect(handle.sessionId).toBe("session-1");
    expect(handle.skillRef).toEqual(skillRef);
    expect(handle.contentHash).toBe(skillRef.contentHash);
    expect(handle.issuedAt).toBe(nowValue.toISOString());
    expect(handle.expiresAt).toBe("2026-01-01T00:01:00.000Z");
    expect(handle.consumed).toBe(false);
  });

  it("消费：单次有效（granted → 重放 rejected skill_load_handle_consumed）", () => {
    const handle = issue();
    const first = registry.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(first.status).toBe("granted");
    if (first.status === "granted") {
      expect(first.handle.consumed).toBe(true);
    }
    const replay = registry.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") {
      expect(replay.reasonCode).toBe("skill_load_handle_consumed");
    }
  });

  it("过期 → rejected skill_load_handle_expired（不返回正文）", () => {
    const handle = issue({ ttlMs: 1000 });
    nowValue = new Date("2026-01-01T00:00:05.000Z"); // 超过 TTL
    const result = registry.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reasonCode).toBe("skill_load_handle_expired");
    }
  });

  it("绑定不符（turn/session 不匹配）→ rejected，handle 未被消费", () => {
    const handle = issue();
    const wrongTurn = registry.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-2", sessionId: "session-1" });
    expect(wrongTurn.status).toBe("rejected");
    if (wrongTurn.status === "rejected") {
      expect(wrongTurn.reasonCode).toBe("skill_content_read_denied");
    }
    // 未消费：正确绑定仍可用
    const ok = registry.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(ok.status).toBe("granted");
  });

  it("未知 handle → rejected skill_content_read_denied", () => {
    const result = registry.consumeLoadHandle({ handleId: "load-does-not-exist", turnId: "turn-1", sessionId: "session-1" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reasonCode).toBe("skill_content_read_denied");
    }
  });

  it("invalidateTurn：turn 结束全部失效（后续消费 → 过期诊断）", () => {
    const h1 = issue();
    const h2 = issue({ sessionId: "session-2" });
    const count = registry.invalidateTurn("turn-1");
    expect(count).toBe(2);
    const result = registry.consumeLoadHandle({ handleId: h1.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reasonCode).toBe("skill_load_handle_expired");
    }
    // 其他 turn 不受影响
    const otherTurn = registry.issueLoadHandle({
      turnId: "turn-9",
      sessionId: "session-9",
      skillRef,
      contentHash: skillRef.contentHash,
      ttlMs: 60_000,
    });
    expect(registry.consumeLoadHandle({ handleId: otherTurn.handleId, turnId: "turn-9", sessionId: "session-9" }).status).toBe("granted");
    expect(h2.handleId).toBeTruthy();
  });

  it("签发校验 fail-closed：contentHash 与 SkillRef 不一致 / 非法 TTL 抛错", () => {
    expect(() =>
      registry.issueLoadHandle({
        turnId: "turn-1",
        sessionId: "session-1",
        skillRef,
        contentHash: "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ttlMs: 60_000,
      }),
    ).toThrow(SkillError);

    expect(() =>
      registry.issueLoadHandle({ turnId: "turn-1", sessionId: "session-1", skillRef, contentHash: skillRef.contentHash, ttlMs: 0 }),
    ).toThrow(SkillError);

    expect(() =>
      registry.issueLoadHandle({
        turnId: "",
        sessionId: "session-1",
        skillRef,
        contentHash: skillRef.contentHash,
        ttlMs: 60_000,
      }),
    ).toThrow(SkillError);
  });

  it("get 返回副本且不改变注册表状态", () => {
    const handle = issue();
    const copy = registry.get(handle.handleId);
    expect(copy).toEqual(handle);
    expect(copy).not.toBe(handle);
    expect(registry.get("load-missing")).toBeUndefined();
  });
});
