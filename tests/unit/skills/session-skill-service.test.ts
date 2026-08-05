import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { tmpDir } from "./helpers.js";
import { cleanupT4Harnesses, createT4Harness, ingestManagedSkill, type T4Harness } from "./t4-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 SessionSkillService（plans/phase-13.md §9.4 / §10.2 / §18.4）
// - 无 Agent Session 临时绑定（TTL 过期失效；不自动升级为持久绑定）；
// - 一次性激活授权：消费 / 重放拒绝 / 过期拒绝 / 目标不一致拒绝。
// ═══════════════════════════════════════════════════════════════

function activationEvents(harness: T4Harness, eventName: string): Array<{ event_name: string }> {
  return harness.db
    .prepare("SELECT event_name FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<{ event_name: string }>;
}

afterEach(() => {
  cleanupT4Harnesses();
});

describe("SessionSkillService.bindTemporary：TTL 与不过期", () => {
  it("ttlMs 提供 → expires_at 写入；到期后从 active 移到 expired", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);

    const binding = harness.sessionService.bindTemporary({ sessionId: "sess-1", skillRef: registered.skillRef, ttlMs: 60_000 });
    expect(binding.expiresAt).toBe("2026-01-01T00:01:00.000Z");
    expect(harness.sessionService.listSessionSkills("sess-1").active.map((b) => b.skillRefKey)).toEqual([key]);
    expect(harness.sessionService.listSessionSkills("sess-1").expired).toHaveLength(0);

    harness.advance(61_000);
    const view = harness.sessionService.listSessionSkills("sess-1");
    expect(view.active).toHaveLength(0);
    expect(view.expired.map((b) => b.skillRefKey)).toEqual([key]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("无 ttlMs → 不过期；同一 Session 重新绑定覆盖 selection", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.sessionService.bindTemporary({ sessionId: "sess-1", skillRef: registered.skillRef });
    const view = harness.sessionService.listSessionSkills("sess-1");
    expect(view.active[0]?.expiresAt).toBeNull();

    harness.sessionService.bindTemporary({ sessionId: "sess-1", skillRef: registered.skillRef, selection: "explicit-only", ttlMs: 120_000 });
    expect(harness.sessionService.listSessionSkills("sess-1").active).toHaveLength(1);
    expect(harness.sessionService.listSessionSkills("sess-1").active[0]?.selection).toBe("explicit-only");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("临时绑定不写入 Agent skills.json（Session 结束不自动升级）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.sessionService.bindTemporary({ sessionId: "sess-1", skillRef: registered.skillRef, ttlMs: 60_000 });
    expect(harness.agentService.getSkillsConfig("agent-x").directSkillRefs).toHaveLength(0);
    expect(harness.bindingStore.listByAgent("agent-x")).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("临时绑定未知 SkillRef → fail-closed 拒绝", () => {
    const harness = createT4Harness();
    expect(() =>
      harness.sessionService.bindTemporary({
        sessionId: "sess-1",
        skillRef: { skillId: "ghost", sourceId: "/g", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-g" },
      }),
    ).toThrow(SkillError);
  });
});

describe("SessionSkillService.issueActivationGrant / consumeActivationGrant", () => {
  it("签发 → 消费成功（一次性）：grant 记录 consumed_at，activity consumed", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);

    const grant = harness.sessionService.issueActivationGrant({
      agentId: "a1",
      sessionId: "sess-1",
      skillRef: registered.skillRef,
      issuedTurnId: "turn-1",
      ttlMs: 300_000,
      reason: "session-install",
    });
    expect(grant.skillRefKey).toBe(key);
    expect(grant.contentHash).toBe(registered.skillRef.contentHash);
    expect(grant.expiresAt).toBe("2026-01-01T00:05:00.000Z");
    expect(activationEvents(harness, "skill.activation.granted")).toHaveLength(1);

    const consumed = harness.sessionService.consumeActivationGrant({
      grantId: grant.grantId,
      sessionId: "sess-1",
      skillRef: registered.skillRef,
      contentHash: registered.skillRef.contentHash,
    });
    expect(consumed.status).toBe("consumed");
    if (consumed.status !== "consumed") return;
    expect(consumed.grant.consumedAt).not.toBeNull();
    expect(harness.grants.get(grant.grantId)?.consumedAt).not.toBeNull();
    expect(activationEvents(harness, "skill.activation.consumed")).toHaveLength(1);
    expect(harness.grants.listBySession("sess-1")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("重放消费 → skill_activation_reused（一次性语义）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const grant = harness.sessionService.issueActivationGrant({
      agentId: "a1",
      sessionId: "sess-1",
      skillRef: registered.skillRef,
      issuedTurnId: "turn-1",
      ttlMs: 300_000,
    });
    harness.sessionService.consumeActivationGrant({ grantId: grant.grantId, sessionId: "sess-1", skillRef: registered.skillRef, contentHash: registered.skillRef.contentHash });

    const replay = harness.sessionService.consumeActivationGrant({ grantId: grant.grantId, sessionId: "sess-1", skillRef: registered.skillRef, contentHash: registered.skillRef.contentHash });
    expect(replay.status).toBe("rejected");
    if (replay.status !== "rejected") return;
    expect(replay.reasonCode).toBe("skill_activation_reused");
    expect(activationEvents(harness, "skill.activation.rejected")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("过期消费 → skill_activation_expired（消费被拒，证据保留）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const grant = harness.sessionService.issueActivationGrant({
      agentId: "a1",
      sessionId: "sess-1",
      skillRef: registered.skillRef,
      issuedTurnId: "turn-1",
      ttlMs: 60_000,
    });
    harness.advance(61_000);
    const result = harness.sessionService.consumeActivationGrant({ grantId: grant.grantId, sessionId: "sess-1", skillRef: registered.skillRef, contentHash: registered.skillRef.contentHash });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasonCode).toBe("skill_activation_expired");
    // 过期不消费：consumed_at 仍为 null（证据保留可查询）
    expect(harness.grants.get(grant.grantId)?.consumedAt).toBeNull();
    expect(activationEvents(harness, "skill.activation.expired")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("Session / skillRefKey / contentHash 不一致 → skill_activation_denied", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const grant = harness.sessionService.issueActivationGrant({
      agentId: "a1",
      sessionId: "sess-1",
      skillRef: registered.skillRef,
      issuedTurnId: "turn-1",
      ttlMs: 300_000,
    });
    const otherSession = harness.sessionService.consumeActivationGrant({ grantId: grant.grantId, sessionId: "sess-2", skillRef: registered.skillRef, contentHash: registered.skillRef.contentHash });
    expect(otherSession.status).toBe("rejected");
    if (otherSession.status !== "rejected") return;
    expect(otherSession.reasonCode).toBe("skill_activation_denied");

    const wrongHash = harness.sessionService.consumeActivationGrant({ grantId: grant.grantId, sessionId: "sess-1", skillRef: registered.skillRef, contentHash: "sha256-wrong" });
    expect(wrongHash.status).toBe("rejected");
    if (wrongHash.status !== "rejected") return;
    expect(wrongHash.reasonCode).toBe("skill_activation_denied");

    const wrongRef = harness.sessionService.consumeActivationGrant({
      grantId: grant.grantId,
      sessionId: "sess-1",
      skillRef: { ...registered.skillRef, version: "9.9.9" },
      contentHash: registered.skillRef.contentHash,
    });
    expect(wrongRef.status).toBe("rejected");
    if (wrongRef.status !== "rejected") return;
    expect(wrongRef.reasonCode).toBe("skill_activation_denied");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("不存在的 grantId → fail-closed 抛错（skill_activation_denied）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    expect(() =>
      harness.sessionService.consumeActivationGrant({ grantId: "grant-unknown", sessionId: "sess-1", skillRef: registered.skillRef, contentHash: registered.skillRef.contentHash }),
    ).toThrow(SkillError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("签发未知 SkillRef → fail-closed 拒绝", () => {
    const harness = createT4Harness();
    expect(() =>
      harness.sessionService.issueActivationGrant({
        agentId: "a1",
        sessionId: "sess-1",
        skillRef: { skillId: "ghost", sourceId: "/g", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-g" },
        issuedTurnId: "turn-1",
        ttlMs: 300_000,
      }),
    ).toThrow(SkillError);
  });
});
