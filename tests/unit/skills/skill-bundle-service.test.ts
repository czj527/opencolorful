import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorRef } from "../../../src/contracts/observability.js";
import { skillRefKey, type SkillRef } from "../../../src/contracts/skill-protocol.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { computeBundleContentHash } from "../../../src/runtime/skills/bundles/skill-bundle-service.js";
import { tmpDir } from "./helpers.js";
import { cleanupT4Harnesses, createT4Harness, ingestManagedSkill, type T4Harness } from "./t4-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 SkillBundleService（plans/phase-13.md §9.3 / §11.6 / §18.3）
// - 版本化（新版本不变更旧版本）、contentHash 由 items+name+source 计算；
// - bindBundleToAgent / migrate（保留旧绑定 + 前后差异）/ rollback / unbind；
// - 所有 Agent 变更走严格审计；未解析 SkillRef fail-closed。
// ═══════════════════════════════════════════════════════════════

const userActor: ActorRef = { kind: "user", id: "user-1" };

function auditRows(harness: T4Harness, pattern: string): Array<{ event_name: string; operation_id: string | null; before_revision: string | null; after_revision: string | null }> {
  return harness.db
    .prepare(
      `SELECT event_name, operation_id, before_revision, after_revision
       FROM audit_events WHERE event_name LIKE ? ORDER BY id ASC`,
    )
    .all(pattern) as Array<{ event_name: string; operation_id: string | null; before_revision: string | null; after_revision: string | null }>;
}

function activityRows(harness: T4Harness, eventName: string): Array<{ event_name: string }> {
  return harness.db
    .prepare("SELECT event_name FROM activity_events WHERE event_name = ? ORDER BY id ASC")
    .all(eventName) as Array<{ event_name: string }>;
}

function registeredSkillOf(harness: T4Harness, skillId: string): SkillRef {
  const found = harness.catalog.list({}).find((candidate) => candidate.skillId === skillId);
  if (found === undefined) {
    throw new Error(`test skill not registered: ${skillId}`);
  }
  return found.skillRef;
}

afterEach(() => {
  cleanupT4Harnesses();
});

describe("SkillBundleService.createBundle：版本化与内容哈希", () => {
  it("首个版本 = 1；新版本自增且旧版本不变更（不原地覆盖）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const beta = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });

    const v1 = harness.bundleService.createBundle({
      bundleId: "crew",
      name: "Crew Skills",
      items: [{ skillRef: alpha.skillRef }, { skillRef: beta.skillRef, selection: "explicit-only", ordinal: 1 }],
      sourceKind: "managed",
      sourceId: "test",
      actor: userActor,
    });
    expect(v1.version).toBe("1");
    expect(v1.items).toHaveLength(2);
    expect(v1.supersedesVersion).toBeNull();

    // 新版本：调整 items（去掉 beta，加入 gamma）
    const gamma = ingestManagedSkill(harness, root, { name: "gamma", version: "1.0.0" });
    const v2 = harness.bundleService.createBundle({
      bundleId: "crew",
      name: "Crew Skills v2",
      items: [{ skillRef: alpha.skillRef }, { skillRef: gamma.skillRef }],
      sourceKind: "managed",
      sourceId: "test",
      actor: userActor,
    });
    expect(v2.version).toBe("2");
    expect(v2.supersedesVersion).toBe("1");

    // 旧版本完全保留（内容哈希、items 不变更）
    const v1Again = harness.bundleService.getBundle("crew", "1");
    expect(v1Again).not.toBeNull();
    expect(v1Again?.contentHash).toBe(v1.contentHash);
    expect(v1Again?.items.map((i) => i.skillRefKey).sort()).toEqual(
      [skillRefKey(alpha.skillRef), skillRefKey(beta.skillRef)].sort(),
    );
    expect(v1Again?.items.find((i) => i.skillRefKey === skillRefKey(beta.skillRef))?.selection).toBe("explicit-only");
    expect(v2.contentHash).not.toBe(v1.contentHash);

    // 版本列表齐全（listVersions 与 latestVersion）
    expect(harness.bundleService.listBundleVersions("crew").map((v) => v.version)).toEqual(["2", "1"]);
    expect(harness.bundleService.getBundle("crew", "99")).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("contentHash 由 items+name+source 计算（bundleId 不参与；相同内容哈希一致）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const items = [{ skillRef: alpha.skillRef, selection: "implicit" as const, ordinal: 0 }];
    const a = harness.bundleService.createBundle({ bundleId: "b1", name: "Same", items, sourceKind: "managed", sourceId: "s1", actor: userActor });
    const b = harness.bundleService.createBundle({ bundleId: "b2", name: "Same", items, sourceKind: "managed", sourceId: "s1", actor: userActor });
    expect(a.contentHash).toBe(b.contentHash);
    // 函数签名一致性：bundleId 不参与
    const direct = computeBundleContentHash("Same", "managed", "s1", items.map((i) => ({ skillRefKey: skillRefKey(i.skillRef), selection: i.selection, ordinal: i.ordinal })));
    expect(a.contentHash).toBe(direct);
    // 名称变化 → 哈希变化
    const renamed = computeBundleContentHash("Other", "managed", "s1", items.map((i) => ({ skillRefKey: skillRefKey(i.skillRef), selection: i.selection, ordinal: i.ordinal })));
    expect(renamed).not.toBe(a.contentHash);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("非法输入 fail-closed：空 items / 重复项 / 未知 SkillRef / 非法 selection", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    expect(() =>
      harness.bundleService.createBundle({ bundleId: "b", name: "n", items: [], sourceKind: "managed", sourceId: "s", actor: userActor }),
    ).toThrow(/至少包含一个/);
    expect(() =>
      harness.bundleService.createBundle({
        bundleId: "b",
        name: "n",
        items: [{ skillRef: alpha.skillRef }, { skillRef: alpha.skillRef }],
        sourceKind: "managed",
        sourceId: "s",
        actor: userActor,
      }),
    ).toThrow(/重复/);
    const ghost: SkillRef = { skillId: "ghost", sourceId: "/g", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-g" };
    expect(() =>
      harness.bundleService.createBundle({ bundleId: "b", name: "n", items: [{ skillRef: ghost }], sourceKind: "managed", sourceId: "s", actor: userActor }),
    ).toThrow(SkillError);
    expect(() =>
      harness.bundleService.createBundle({
        bundleId: "b",
        name: "n",
        items: [{ skillRef: alpha.skillRef, selection: "shadowed" as never }],
        sourceKind: "managed",
        sourceId: "s",
        actor: userActor,
      }),
    ).toThrow(/选择模式/);
    // 审计：只有成功的版本化留下三阶段
    expect(auditRows(harness, "audit.skill.bundle_change_%")).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("创建 Bundle 走严格审计（bundle_change started/completed）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    const rows = auditRows(harness, "audit.skill.bundle_change_%").filter((r) => r.operation_id !== null);
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.skill.bundle_change_started",
      "audit.skill.bundle_change_completed",
    ]);
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
    expect(activityRows(harness, "skill.bundle.created")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("SkillBundleService.resolveBundleRefs / bindBundleToAgent", () => {
  it("resolveBundleRefs 解析精确 SkillRef；Catalog 缺失项进入 missing（fail-closed）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });

    const resolved = harness.bundleService.resolveBundleRefs("crew", "1");
    expect(resolved.resolved).toHaveLength(1);
    expect(resolved.resolved[0]?.skillRef.contentHash).toBe(alpha.skillRef.contentHash);
    expect(resolved.missing).toHaveLength(0);

    // 从 Catalog 移除 alpha → 再解析出现 missing
    harness.catalog.removeBySkillId("alpha");
    const after = harness.bundleService.resolveBundleRefs("crew", "1");
    expect(after.resolved).toHaveLength(0);
    expect(after.missing).toEqual([skillRefKey(alpha.skillRef)]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bindBundleToAgent：写 skills.json bundleBindings + 投影（pinned）+ 严格审计", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const beta = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });
    harness.bundleService.createBundle({
      bundleId: "crew",
      name: "Crew",
      items: [
        { skillRef: alpha.skillRef },
        { skillRef: beta.skillRef, selection: "explicit-only" },
      ],
      sourceKind: "managed",
      sourceId: "test",
      actor: userActor,
    });

    const result = harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "1", actor: userActor });
    expect(result.version).toBe("1");

    const config = harness.agentService.getSkillsConfig("a1");
    expect(config.bundleBindings).toEqual([{ bundleId: "crew", version: "1", pinned: true }]);
    const alphaKey = skillRefKey(alpha.skillRef);
    const betaKey = skillRefKey(beta.skillRef);
    const alphaRow = harness.bindingStore.get("a1", alphaKey);
    expect(alphaRow?.pinned).toBe(true);
    expect(alphaRow?.bundleId).toBe("crew");
    expect(alphaRow?.bundleVersion).toBe("1");
    expect(alphaRow?.selection).toBe("implicit");
    expect(harness.bindingStore.get("a1", betaKey)?.selection).toBe("explicit-only");

    const rows = auditRows(harness, "audit.skill.binding_change_%").filter((r) => r.operation_id !== null);
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.skill.binding_change_started",
      "audit.skill.binding_change_completed",
    ]);
    expect(activityRows(harness, "skill.bound")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("绑定含未解析项的 Bundle → fail-closed 拒绝（不部分绑定）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.catalog.removeBySkillId("alpha");

    expect(() => harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "1", actor: userActor })).toThrow(SkillError);
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings).toHaveLength(0);
    expect(harness.bindingStore.listByAgent("a1")).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("SkillBundleService.migrateBundle / rollbackBundle / unbindBundle", () => {
  it("迁移保留旧绑定（旧版本可回滚）并把前后差异写入审计与 activity", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const beta = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.bundleService.createBundle({
      bundleId: "crew",
      name: "Crew v2",
      items: [{ skillRef: alpha.skillRef }, { skillRef: beta.skillRef }],
      sourceKind: "managed",
      sourceId: "test",
      actor: userActor,
    });
    harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "1", actor: userActor });

    const migrated = harness.bundleService.migrateBundle({
      agentId: "a1",
      from: { bundleId: "crew", version: "1", contentHash: "sha256-v1" },
      to: { bundleId: "crew", version: "2", contentHash: "sha256-v2" },
      actor: userActor,
    });
    expect(migrated.version).toBe("2");
    // 配置迁移到 v2
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings[0]?.version).toBe("2");
    // 旧版本仍可回滚（Store 保留 + 审计 before/after 记录差异）
    expect(harness.bundleService.listBundleVersions("crew").map((v) => v.version)).toEqual(["2", "1"]);
    const rows = auditRows(harness, "audit.skill.binding_change_%").filter((r) => r.operation_id !== null);
    const migrateRow = rows[rows.length - 1];
    expect(migrateRow?.event_name).toBe("audit.skill.binding_change_completed");
    expect(migrateRow?.before_revision).toBe("bundle:crew@1");
    expect(migrateRow?.after_revision).toBe("bundle:crew@2");
    // activity 差异（skillRefKey 含路径会被安全层脱敏，差异以计数承载）
    const migratedEvents = harness.db
      .prepare("SELECT payload_json FROM activity_events WHERE event_name = 'skill.bundle.migrated' ORDER BY id DESC LIMIT 1")
      .get() as { payload_json: string } | undefined;
    const attributes = (JSON.parse(migratedEvents?.payload_json ?? "{}") as { attributes?: Record<string, unknown> }).attributes ?? {};
    expect(attributes["addedCount"]).toBe(1);
    expect(attributes["removedCount"]).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("迁移源未绑定 / 跨 Bundle → 拒绝", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew v2", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    expect(() =>
      harness.bundleService.migrateBundle({ agentId: "a1", from: { bundleId: "crew", version: "1", contentHash: "h1" }, to: { bundleId: "crew", version: "2", contentHash: "h2" }, actor: userActor }),
    ).toThrow(/未绑定/);
    expect(() =>
      harness.bundleService.migrateBundle({ agentId: "a1", from: { bundleId: "crew", version: "1", contentHash: "h1" }, to: { bundleId: "other", version: "1", contentHash: "h2" }, actor: userActor }),
    ).toThrow(/同一 Bundle/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rollbackBundle 回滚到旧版本，走 rollback 审计三阶段", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    const beta = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew v2", items: [{ skillRef: alpha.skillRef }, { skillRef: beta.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "2", actor: userActor });

    const rolled = harness.bundleService.rollbackBundle({ agentId: "a1", bundleId: "crew", targetVersion: "1", actor: userActor });
    expect(rolled.version).toBe("1");
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings[0]?.version).toBe("1");
    // 投影只含 v1 的 alpha
    expect(harness.bindingStore.listByAgent("a1").map((r) => r.skillRefKey)).toEqual([skillRefKey(alpha.skillRef)]);

    const rows = auditRows(harness, "audit.skill.rollback_%").filter((r) => r.operation_id !== null);
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.skill.rollback_started",
      "audit.skill.rollback_completed",
    ]);
    expect(rows[0]?.before_revision).toBe("bundle:crew@2");
    expect(rows[1]?.after_revision).toBe("bundle:crew@1");
    expect(activityRows(harness, "skill.bundle.rolled_back")).toHaveLength(1);

    // 回滚到不存在版本 → 拒绝
    expect(() => harness.bundleService.rollbackBundle({ agentId: "a1", bundleId: "crew", targetVersion: "99", actor: userActor })).toThrow(SkillError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("unbindBundle 需要确认；确认后移除 bundleBindings 与投影", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "1", actor: userActor });

    const denied = harness.bundleService.unbindBundle({ agentId: "a1", bundleId: "crew", confirmed: false, actor: userActor });
    expect(denied.status).toBe("confirmation_required");
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings).toHaveLength(1);

    const unbound = harness.bundleService.unbindBundle({ agentId: "a1", bundleId: "crew", confirmed: true, actor: userActor });
    expect(unbound.status).toBe("unbound");
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings).toHaveLength(0);
    expect(harness.bindingStore.listByAgent("a1")).toHaveLength(0);
    expect(activityRows(harness, "skill.unbound.approved")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("审计 rejected 时 Bundle 绑定回滚（文件恢复 + 投影回滚）", () => {
    const harness = createT4Harness();
    const root = tmpDir();
    const alpha = ingestManagedSkill(harness, root, { name: "alpha", version: "1.0.0" });
    harness.bundleService.createBundle({ bundleId: "crew", name: "Crew", items: [{ skillRef: alpha.skillRef }], sourceKind: "managed", sourceId: "test", actor: userActor });
    // 预置一个已存在的 skills.json（通过绑定一个直接 Skill）
    const beta = ingestManagedSkill(harness, root, { name: "beta", version: "1.0.0" });
    harness.agentService.bindSkill({ agentId: "a1", skillRef: beta.skillRef, actor: userActor });
    const beforeFile = fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8");

    const rejecting = createRejectingAudit(harness.db);
    (harness.bundleService as unknown as { deps: { audit: import("../../../src/observability/audit-recorder.js").AuditRecorder } }).deps.audit = rejecting;

    expect(() => harness.bundleService.bindBundleToAgent({ agentId: "a1", bundleId: "crew", version: "1", actor: userActor })).toThrow(/审计/);
    expect(fs.readFileSync(path.join(harness.paths.agents, "a1", "skills.json"), "utf8")).toBe(beforeFile);
    expect(harness.agentService.getSkillsConfig("a1").bundleBindings).toHaveLength(0);
    expect(harness.bindingStore.listByAgent("a1").map((r) => r.skillRefKey)).toEqual([skillRefKey(beta.skillRef)]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/** 模拟 completed 审计被拒绝：领域写入在真实事务内执行后抛错（事务回滚），随后服务补偿文件。 */
function createRejectingAudit(db: { transaction<T>(fn: () => T): () => T }): import("../../../src/observability/audit-recorder.js").AuditRecorder {
  const fake = {
    appendStrict: (_input: unknown) => ({ kind: "accepted" as const, eventId: "fake", rowId: 1 }),
    runAuditedTransaction: <T>(_input: unknown, domainFn: () => T): { result: T; audit: { kind: string } } => {
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
  return fake as unknown as import("../../../src/observability/audit-recorder.js").AuditRecorder;
}
