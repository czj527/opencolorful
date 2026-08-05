import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorRef } from "../../../src/contracts/observability.js";
import type { AuditRecorder } from "../../../src/observability/audit-recorder.js";
import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { tmpDir } from "./helpers.js";
import { cleanupT4Harnesses, createT4Harness, ingestManagedSkill, ingestWorkspaceSkill, type T4Harness } from "./t4-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 AgentSkillService（plans/phase-13.md §9.4 / §11.6 / §13.2 / §18.3）
// - bindSkill 严格审计（含审计 rejected 时领域回滚）；
// - setSelection 三模式 + disabled 需确认；unbind 需确认；
// - listAgentSkills 与 resolver 集成（pinned/overrides/workspace 不写 skills.json）；
// - rebuildBindingIndex 一致性；学习策略变更需确认。
// ═══════════════════════════════════════════════════════════════

const userActor: ActorRef = { kind: "user", id: "user-1" };

function auditRows(harness: T4Harness): Array<{ event_name: string; operation_id: string | null; before_revision: string | null; after_revision: string | null }> {
  return harness.db
    .prepare(
      `SELECT event_name, operation_id, before_revision, after_revision
       FROM audit_events WHERE event_name LIKE 'audit.skill.binding_change_%' ORDER BY id ASC`,
    )
    .all() as Array<{ event_name: string; operation_id: string | null; before_revision: string | null; after_revision: string | null }>;
}

function activityRows(harness: T4Harness, eventName: string): Array<{ event_name: string }> {
  return harness.db
    .prepare("SELECT event_name FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<{ event_name: string }>;
}

afterEach(() => {
  cleanupT4Harnesses();
});

describe("AgentSkillService.bindSkill：Catalog 校验 + 严格审计", () => {
  it("绑定成功后写 skills.json + 投影 + 审计 started/completed 同一 operationId", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);

    const result = harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    expect(result.status).toBe("bound");
    if (result.status !== "bound") return;
    expect(result.skillRefKey).toBe(key);
    expect(result.pinned).toBe(true);
    expect(result.configRevision).toBe(1);

    // skills.json 持久化（directSkillRefs + overrides）
    const config = harness.agentService.getSkillsConfig("a1");
    expect(config.directSkillRefs).toHaveLength(1);
    expect(config.overrides[key]).toBe("implicit");
    // 投影
    const row = harness.bindingStore.get("a1", key);
    expect(row?.pinned).toBe(true);
    expect(row?.configRevision).toBe(1);
    expect(row?.selection).toBe("implicit");
    // 审计三阶段（started + completed，同一 operationId；排除 activity 镜像行）
    const rows = auditRows(harness).filter((r) => r.operation_id !== null);
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.skill.binding_change_started",
      "audit.skill.binding_change_completed",
    ]);
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
    // activity 证据
    expect(activityRows(harness, "skill.bound")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("绑定带显式 selection 写入 overrides", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, selection: "explicit-only", actor: userActor });
    expect(harness.agentService.getSkillsConfig("a1").overrides[skillRefKey(registered.skillRef)]).toBe("explicit-only");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("重复绑定同一精确引用 → already_pinned（幂等，不再写配置）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    const second = harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    expect(second.status).toBe("already_pinned");
    expect(auditRows(harness).filter((r) => r.operation_id !== null)).toHaveLength(2); // 只有第一次产生审计
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("绑定未知 SkillRef（不在 Catalog）→ fail-closed 抛错，无任何写入", () => {
    const harness = createT4Harness();
    const ghost = {
      skillId: "ghost",
      sourceId: "/ghost",
      sourceKind: "managed" as const,
      version: "1.0.0",
      contentHash: "sha256-ghost",
    };
    expect(() => harness.agentService.bindSkill({ agentId: "a1", skillRef: ghost, actor: userActor })).toThrow(SkillError);
    expect(harness.agentService.getSkillsConfig("a1").directSkillRefs).toHaveLength(0);
    expect(harness.bindingStore.listByAgent("a1")).toHaveLength(0);
    expect(auditRows(harness)).toHaveLength(0);
  });

  it("审计 rejected（completed 审计失败）→ 领域回滚：skills.json 与投影均恢复原状", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    // 预置一个旧配置，验证失败后原内容被恢复
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    const beforeFile = fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8");

    // 替换 audit：completed 阶段模拟拒绝（领域写入在真实事务内执行后抛错 → 事务回滚）
    const rejecting = createRejectingAudit(harness.db);
    const patched = harness.agentService;
    (patched as unknown as { deps: { audit: AuditRecorder } }).deps.audit = rejecting;

    const second = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });
    expect(() => patched.bindSkill({ agentId: "a1", skillRef: second.skillRef, actor: userActor })).toThrow(/审计/);
    // 文件恢复为变更前内容
    expect(fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8")).toBe(beforeFile);
    // 投影恢复（事务回滚）：仍然只有 alpha 一行
    expect(harness.bindingStore.listByAgent("a1").map((r) => r.skillRefKey)).toEqual([skillRefKey(registered.skillRef)]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("首次绑定失败（文件不存在）→ 补偿删除文件，配置保持默认", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const rejecting = createRejectingAudit(harness.db);
    (harness.agentService as unknown as { deps: { audit: AuditRecorder } }).deps.audit = rejecting;
    expect(() => harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor })).toThrow(/审计/);
    // 文件被补偿删除 → 读取回默认空配置
    expect(harness.agentService.getSkillsConfig("a1").directSkillRefs).toHaveLength(0);
    expect(fs.existsSync(path.join(harness.paths.agents, "a1", "skills.json"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentSkillService.setSelection：三模式 + disabled 需确认", () => {
  it("implicit / explicit-only / disabled 三种模式持久化到 overrides", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });

    const implicit = harness.agentService.setSelection({ agentId: "a1", skillRefKey: key, selection: "implicit", confirmed: false, actor: userActor });
    expect(implicit.status).toBe("changed");
    const explicit = harness.agentService.setSelection({ agentId: "a1", skillRefKey: key, selection: "explicit-only", confirmed: false, actor: userActor });
    expect(explicit.status).toBe("changed");
    const disabled = harness.agentService.setSelection({ agentId: "a1", skillRefKey: key, selection: "disabled", confirmed: true, actor: userActor });
    expect(disabled.status).toBe("changed");

    const config = harness.agentService.getSkillsConfig("a1");
    expect(config.overrides[key]).toBe("disabled");
    expect(activityRows(harness, "skill.selection.changed")).toHaveLength(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("disabled 未确认 → confirmation_required，不做任何领域修改", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    const before = fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8");

    const result = harness.agentService.setSelection({ agentId: "a1", skillRefKey: key, selection: "disabled", confirmed: false, actor: userActor });
    expect(result.status).toBe("confirmation_required");
    expect(fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8")).toBe(before);
    expect(harness.agentService.getSkillsConfig("a1").overrides[key]).not.toBe("disabled");
    expect(activityRows(harness, "skill.unbound.requested")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("目标不在绑定也不在 Catalog → 拒绝", () => {
    const harness = createT4Harness();
    expect(() =>
      harness.agentService.setSelection({ agentId: "a1", skillRefKey: "nope@nowhere@1.0.0", selection: "implicit", confirmed: false, actor: userActor }),
    ).toThrow(SkillError);
  });
});

describe("AgentSkillService.unbindSkill：需确认", () => {
  it("confirmed=false → confirmation_required，配置与投影不变", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    const before = fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8");

    const result = harness.agentService.unbindSkill({ agentId: "a1", skillRefKey: key, confirmed: false, actor: userActor });
    expect(result.status).toBe("confirmation_required");
    expect(fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8")).toBe(before);
    expect(harness.bindingStore.get("a1", key)).not.toBeNull();
  });

  it("confirmed=true → 移除 directSkillRefs 与 overrides，投影同步", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const key = skillRefKey(registered.skillRef);
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, selection: "explicit-only", actor: userActor });

    const result = harness.agentService.unbindSkill({ agentId: "a1", skillRefKey: key, confirmed: true, actor: userActor });
    expect(result.status).toBe("unbound");
    const config = harness.agentService.getSkillsConfig("a1");
    expect(config.directSkillRefs).toHaveLength(0);
    expect(config.overrides[key]).toBeUndefined();
    expect(harness.bindingStore.get("a1", key)).toBeNull();
    expect(activityRows(harness, "skill.unbound.approved")).toHaveLength(1);
    const rows = auditRows(harness);
    expect(rows[rows.length - 1]?.event_name).toBe("audit.skill.binding_change_completed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("解绑未绑定的引用 → 拒绝", () => {
    const harness = createT4Harness();
    expect(() => harness.agentService.unbindSkill({ agentId: "a1", skillRefKey: "nope@nowhere@1.0.0", confirmed: true, actor: userActor })).toThrow(SkillError);
  });
});

describe("AgentSkillService：listAgentSkills 与 resolver 集成", () => {
  it("pinned direct ref 进入可见集；Workspace 同名候选被 shadowed 且不写 skills.json", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const managed = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    // Workspace 同名候选（更高优先级，但不能替换已固定引用）
    ingestWorkspaceSkill(harness, root, { name: "alpha", version: "2.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: managed.skillRef, actor: userActor });

    const view = harness.agentService.listAgentSkills("a1", { os: "win32", bins: [], env: [], plugins: [], tools: [], capabilities: [] });
    expect(view.visible.map((s) => s.skillRefKey)).toContain(skillRefKey(managed.skillRef));
    expect(view.visible.find((s) => s.skillId === "alpha")?.pinned).toBe(true);
    // workspace 同名被 shadowed（不替换固定引用）
    const shadowed = view.shadowed.find((s) => s.skillId === "alpha");
    expect(shadowed).toBeDefined();
    expect(shadowed?.status.selection).toBe("shadowed");
    // skills.json 只含显式绑定，Workspace Skill 不写入
    const config = harness.agentService.getSkillsConfig("a1");
    expect(config.directSkillRefs).toHaveLength(1);
    expect(config.directSkillRefs[0]?.sourceKind).toBe("managed");
    expect(config.directSkillRefs.some((ref) => ref.sourceKind === "workspace")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("overrides=disabled 的固定引用进入 disabled 集（仍保留绑定）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    harness.agentService.setSelection({ agentId: "a1", skillRefKey: skillRefKey(registered.skillRef), selection: "disabled", confirmed: true, actor: userActor });

    const view = harness.agentService.listAgentSkills("a1", { os: "win32", bins: [], env: [], plugins: [], tools: [], capabilities: [] });
    expect(view.visible).toHaveLength(0);
    expect(view.disabled.map((s) => s.skillRefKey)).toContain(skillRefKey(registered.skillRef));
    // disabled 是明确选择，绑定保留
    expect(harness.agentService.getSkillsConfig("a1").directSkillRefs).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rebuildBindingIndex 从 skills.json 重建投影（先制造漂移再重建）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const registered = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: registered.skillRef, actor: userActor });
    const key = skillRefKey(registered.skillRef);
    // 制造漂移：直接删除投影行
    harness.db.prepare("DELETE FROM agent_skill_binding_index").run();
    expect(harness.bindingStore.listByAgent("a1")).toHaveLength(0);

    const revision = harness.agentService.rebuildBindingIndex("a1");
    expect(revision).toBe(1); // 投影被清空后 maxRevision 归 0，重建从 1 开始
    const row = harness.bindingStore.get("a1", key);
    expect(row?.pinned).toBe(true);
    expect(row?.configRevision).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentSkillService：学习策略", () => {
  it("setLearningPolicy 未确认 → confirmation_required；确认后生效", () => {
    const harness = createT4Harness();
    const denied = harness.agentService.setLearningPolicy({ agentId: "a1", policy: "disabled", confirmed: false, actor: userActor });
    expect(denied.status).toBe("confirmation_required");
    expect(harness.agentService.getLearningPolicy("a1")).toBe("ask-on-risk");

    const changed = harness.agentService.setLearningPolicy({ agentId: "a1", policy: "disabled", confirmed: true, actor: userActor });
    expect(changed.status).toBe("changed");
    expect(harness.agentService.getLearningPolicy("a1")).toBe("disabled");
    // 变更走严格审计（学习策略无 activity，无镜像行）
    const rows = auditRows(harness);
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.skill.binding_change_started",
      "audit.skill.binding_change_completed",
    ]);
    expect(rows[0]?.before_revision).toBe("0");
    expect(rows[1]?.after_revision).toBe("1");
  });
});

/** 模拟 completed 审计被拒绝：领域写入在真实事务内执行后抛错（事务回滚），随后服务补偿文件。 */
function createRejectingAudit(db: { transaction<T>(fn: () => T): () => T }): AuditRecorder {
  const fake = {
    appendStrict: (_input: { eventName: string }) => ({ kind: "accepted" as const, eventId: "fake", rowId: 1 }),
    runAuditedTransaction: <T>(_input: { eventName: string }, domainFn: () => T): { result: T; audit: { kind: string } } => {
      const run = db.transaction(() => {
        domainFn();
        throw new Error("模拟 completed 审计被拒绝（事务回滚）");
      });
      try {
        run();
      } catch {
        // 领域写入已回滚
      }
      throw new Error("审计记录未被接受：模拟 completed 审计被拒绝");
    },
  };
  return fake as unknown as AuditRecorder;
}
