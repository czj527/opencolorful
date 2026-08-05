import { describe, expect, it } from "vitest";

import { ConfirmationTokenRegistry } from "../../../src/runtime/skills/confirmation/confirmation-token.js";
import type { ConfirmationTarget } from "../../../src/runtime/skills/confirmation/confirmation-token.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 一次性确认令牌（plans/phase-13.md §11.4 / §18.5）
// - 过期 → skill_confirmation_expired；重放 → skill_confirmation_reused；
// - 目标变更 → skill_confirmation_target_mismatch；
// - approve 只标记确认证据，consume 才真正消费（一次性）。
// ═══════════════════════════════════════════════════════════════

function makeTarget(overrides: Partial<ConfirmationTarget> = {}): ConfirmationTarget {
  return {
    sourceRef: "local:/tmp/skill-a",
    version: "1.0.0",
    contentHash: "hash-aaa",
    agentId: "agent-1",
    sessionId: "session-1",
    operationType: "install",
    ...overrides,
  };
}

function makeRegistry(): { registry: ConfirmationTokenRegistry; advance: (ms: number) => void } {
  let nowValue = new Date("2026-01-01T00:00:00.000Z");
  const registry = new ConfirmationTokenRegistry({ now: () => nowValue, ttlMs: 60_000 });
  return {
    registry,
    advance(ms: number) {
      nowValue = new Date(nowValue.getTime() + ms);
    },
  };
}

describe("确认令牌：签发与正常消费", () => {
  it("issue → approve → consume 全流程成功（一次性）", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    expect(issued.token).toMatch(/^ct-/);
    expect(issued.expiresAt > "2026-01-01").toBe(true);

    const approved = registry.approveSkillAction({ token: issued.token, agentId: "agent-1", sessionId: "session-1" });
    expect(approved.status).toBe("approved");

    const consumed = registry.consumeConfirmation({ token: issued.token, target: makeTarget() });
    expect(consumed.status).toBe("approved");
    expect(consumed.status === "approved" && consumed.record.consumedAt).not.toBeNull();
  });

  it("consume 必须已 approve：未确认直接消费被拒绝（target_mismatch）", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    const outcome = registry.consumeConfirmation({ token: issued.token, target: makeTarget() });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reasonCode).toBe("skill_confirmation_target_mismatch");
    }
  });
});

describe("确认令牌：失败路径（fail-closed 稳定 reasonCode）", () => {
  it("过期：consume → skill_confirmation_expired", () => {
    const { registry, advance } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    registry.approveSkillAction({ token: issued.token });
    advance(61_000);
    const outcome = registry.consumeConfirmation({ token: issued.token, target: makeTarget() });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reasonCode).toBe("skill_confirmation_expired");
    }
  });

  it("过期：approve → skill_confirmation_expired", () => {
    const { registry, advance } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    advance(61_000);
    const outcome = registry.approveSkillAction({ token: issued.token });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reasonCode).toBe("skill_confirmation_expired");
    }
  });

  it("重放：二次 approve → skill_confirmation_reused", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    expect(registry.approveSkillAction({ token: issued.token }).status).toBe("approved");
    const replay = registry.approveSkillAction({ token: issued.token });
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") {
      expect(replay.reasonCode).toBe("skill_confirmation_reused");
    }
  });

  it("重放：consume 两次 → skill_confirmation_reused", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    registry.approveSkillAction({ token: issued.token });
    expect(registry.consumeConfirmation({ token: issued.token, target: makeTarget() }).status).toBe("approved");
    const replay = registry.consumeConfirmation({ token: issued.token, target: makeTarget() });
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") {
      expect(replay.reasonCode).toBe("skill_confirmation_reused");
    }
  });

  it("目标变更：sourceRef 不一致 → skill_confirmation_target_mismatch", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    registry.approveSkillAction({ token: issued.token });
    const outcome = registry.consumeConfirmation({
      token: issued.token,
      target: makeTarget({ sourceRef: "local:/tmp/skill-b" }),
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reasonCode).toBe("skill_confirmation_target_mismatch");
    }
  });

  it("目标变更：version / contentHash / agentId / sessionId / operationType 任一不一致都拒绝", () => {
    const { registry } = makeRegistry();
    for (const overrides of [
      { version: "2.0.0" },
      { contentHash: "hash-bbb" },
      { agentId: "agent-2" },
      { sessionId: "session-2" },
      { operationType: "unbind" as const },
    ]) {
      const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
      registry.approveSkillAction({ token: issued.token });
      const outcome = registry.consumeConfirmation({ token: issued.token, target: makeTarget(overrides) });
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reasonCode).toBe("skill_confirmation_target_mismatch");
      }
    }
  });

  it("approve 时 agent/session 绑定不一致 → skill_confirmation_target_mismatch", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({ target: makeTarget(), reason: "高风险安装" });
    const wrongAgent = registry.approveSkillAction({ token: issued.token, agentId: "agent-999" });
    expect(wrongAgent.status).toBe("rejected");
    if (wrongAgent.status === "rejected") {
      expect(wrongAgent.reasonCode).toBe("skill_confirmation_target_mismatch");
    }
    const wrongSession = registry.approveSkillAction({ token: issued.token, sessionId: "session-999" });
    expect(wrongSession.status).toBe("rejected");
    if (wrongSession.status === "rejected") {
      expect(wrongSession.reasonCode).toBe("skill_confirmation_target_mismatch");
    }
  });

  it("未知令牌 → skill_confirmation_target_mismatch（不存在或已失效）", () => {
    const { registry } = makeRegistry();
    const outcome = registry.consumeConfirmation({ token: "ct-unknown", target: makeTarget() });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reasonCode).toBe("skill_confirmation_target_mismatch");
    }
  });

  it("非 install 操作（unbind）也可签发并消费", () => {
    const { registry } = makeRegistry();
    const target = makeTarget({ sourceRef: "skill-x@source@1.0.0", operationType: "unbind" });
    const issued = registry.issue({ target, reason: "解绑需要用户确认" });
    expect(registry.approveSkillAction({ token: issued.token }).status).toBe("approved");
    const consumed = registry.consumeConfirmation({ token: issued.token, target });
    expect(consumed.status).toBe("approved");
  });
});
