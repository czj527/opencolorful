import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SkillRef } from "../../../src/contracts/skill-protocol.js";
import type { ResolveOutput } from "../../../src/runtime/skills/resolver.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import {
  SkillSnapshotService,
  SKILL_SNAPSHOT_PREFIX,
  deepFreeze,
} from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { createSkillPackage, ingestPackage, makeEnv, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 Snapshot 单元测试（tests/unit/skills/）
// ═══════════════════════════════════════════════════════════════

describe("SkillSnapshotService", () => {
  let root: string;
  let catalog: SkillCatalog;
  let service: SkillSnapshotService;
  let nowValue: Date;

  beforeEach(() => {
    root = tmpDir("ocf-snap-");
    catalog = new SkillCatalog();
    nowValue = new Date("2026-01-01T00:00:00.000Z");
    service = new SkillSnapshotService({ now: () => nowValue });
  });

  afterEach(() => {
    rmrf(root);
  });

  function resolveVisible(pinnedRefs: readonly SkillRef[] = []): ResolveOutput {
    return catalog.listByAgent({
      agentId: "agent-1",
      pinnedRefs,
      environment: makeEnv(),
    });
  }

  function emptyResolve(): ResolveOutput {
    return { visible: [], shadowed: [], disabled: [], gated: [], diagnostics: [] };
  }

  function makeSnapshot(overrides: { readonly resolve?: ResolveOutput; readonly agentId?: string; readonly sessionId?: string; readonly turnId?: string } = {}) {
    return service.createSkillSnapshot({
      agentId: overrides.agentId ?? "agent-1",
      sessionId: overrides.sessionId ?? "session-1",
      turnId: overrides.turnId ?? "turn-1",
      resolveOutput: overrides.resolve ?? resolveVisible(),
    });
  }

  it("创建快照：字段完整、deepFreeze 不可变、可见 SkillRef 顺序一致", () => {
    const dir = createSkillPackage(root, { name: "alpha", description: "Alpha Skill", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    // T11（P0-5）：managed 安装默认绑定当前 Agent → 固定引用进入可见集
    const snapshot = makeSnapshot({ resolve: resolveVisible([registered.skillRef]) });
    expect(snapshot.snapshotId.startsWith(SKILL_SNAPSHOT_PREFIX)).toBe(true);
    expect(snapshot.agentId).toBe("agent-1");
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.turnId).toBe("turn-1");
    expect(snapshot.createdAt).toBe(nowValue.toISOString());
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.visibleRefs).toHaveLength(1);
    expect(snapshot.visibleRefs[0]).toEqual(snapshot.entries[0]?.skillRef);
    expect(snapshot.entries[0]?.displayName).toBe("alpha");
    expect(snapshot.entries[0]?.selection).toBe("implicit");
    expect(snapshot.entries[0]?.status.validity).toBe("valid");
    expect(snapshot.entries[0]?.dependency.satisfied).toBe(true);
    expect(snapshot.snapshotHash).toMatch(/^sha256-[0-9a-f]{57}$/);
    expect(snapshot.supportFiles).toEqual([]);

    // deepFreeze：嵌套对象也冻结，严格模式下变更抛 TypeError
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.visibleRefs)).toBe(true);
    expect(() => {
      (snapshot.entries as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.entries[0] as unknown as { displayName: string }).displayName = "mutated";
    }).toThrow(TypeError);
  });

  it("四态结果与诊断进入快照（shadowed/disabled/gated/diagnostics）", () => {
    // 同名三个候选：workspace 胜出、builtin shadowed、未绑定 managed 进 gated（P0-5）
    const managed = createSkillPackage(root, { name: "dup", description: "managed", version: "1.0.0" });
    ingestPackage(catalog, managed, "managed", makeEnv());
    const workspace = createSkillPackage(root, { name: "dup", description: "workspace", version: "2.0.0" });
    ingestPackage(catalog, workspace, "workspace", makeEnv());
    const builtin = createSkillPackage(root, { name: "dup", description: "builtin", version: "3.0.0" });
    ingestPackage(catalog, builtin, "builtin", makeEnv());

    const snapshot = makeSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.description).toBe("workspace");
    expect(snapshot.shadowed.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.shadowed.some((skill) => skill.selection === "shadowed")).toBe(true);
    expect(snapshot.gated.map((skill) => skill.skillRef.sourceKind)).toContain("managed");
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("未绑定候选"))).toBe(true);
  });

  it("激活授权摘要冻结：未消费未过期项进入快照", () => {
    const dir = createSkillPackage(root, { name: "alpha", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const snapshot = service.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: emptyResolve(),
      activationGrants: [
        {
          grantId: "grant-1",
          agentId: "agent-1",
          sessionId: "session-1",
          skillRefKey: `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`,
          contentHash: registered.skillRef.contentHash,
          issuedTurnId: "turn-1",
          expiresAt: "2026-01-02T00:00:00.000Z",
          consumedAt: null,
          reason: "test",
        },
      ],
    });
    expect(snapshot.activationGrants).toHaveLength(1);
    expect(snapshot.activationGrants[0]?.grantId).toBe("grant-1");
    expect(snapshot.activationGrants[0]?.consumedAt).toBeNull();
  });

  it("元数据预算：超限截断并标记 truncated（pinned 优先）", () => {
    const dir1 = createSkillPackage(root, { name: "pinned-skill", description: "x".repeat(200), version: "1.0.0" });
    const dir2 = createSkillPackage(root, { name: "implicit-skill", description: "y".repeat(200), version: "1.0.0" });
    const pinned = ingestPackage(catalog, dir1, "managed", makeEnv());
    const implicit = ingestPackage(catalog, dir2, "managed", makeEnv());
    const output = catalog.listByAgent({
      agentId: "agent-1",
      pinnedRefs: [pinned.skillRef, implicit.skillRef],
      environment: makeEnv(),
    });
    // implicit 候选仍可见（同名不同 id）
    expect(output.visible.map((skill) => skill.skillId)).toContain(implicit.skillId);

    const small = new SkillSnapshotService({ now: () => nowValue, budgets: { maxMetadataChars: 60 } });
    const snapshot = small.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: output,
    });
    expect(snapshot.metadata.truncated).toBe(true);
    expect(snapshot.metadata.charCount).toBeLessThanOrEqual(60);
    // pinned 优先：文本以 pinned 条目开头
    expect(snapshot.metadata.text.startsWith(`- ${pinned.skillRef.skillId}`)).toBe(true);
  });

  it("可见条目超过 maxSkillsPerSnapshot → 截断并标记 truncatedSkills", () => {
    const refs = [];
    for (let index = 0; index < 3; index += 1) {
      const dir = createSkillPackage(root, { name: `skill-${index}`, version: "1.0.0" });
      const registered = ingestPackage(catalog, dir, "managed", makeEnv());
      refs.push(registered.skillRef);
    }
    const small = new SkillSnapshotService({ now: () => nowValue, budgets: { maxSkillsPerSnapshot: 2 } });
    const snapshot = small.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: resolveVisible(refs),
    });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.truncatedSkills).toBe(true);
  });

  it("构造失败抛显式错误（绝不返回 undefined）", () => {
    expect(() =>
      service.createSkillSnapshot({
        agentId: "",
        sessionId: "session-1",
        turnId: "turn-1",
        resolveOutput: emptyResolve(),
      }),
    ).toThrow(SkillError);

    expect(() =>
      service.createSkillSnapshot({
        agentId: "agent-1",
        sessionId: "session-1",
        turnId: "turn-1",
        resolveOutput: { visible: "not-an-array" } as unknown as ResolveOutput,
      }),
    ).toThrow(SkillError);
  });

  it("validateSnapshot / snapshotVisibleRefs 对非法快照 fail-closed", () => {
    const snapshot = makeSnapshot();
    expect(service.validateSnapshot(snapshot).ok).toBe(true);
    expect(service.validateSnapshot({ ...snapshot, entries: "broken" }).ok).toBe(false);
    expect(service.snapshotVisibleRefs(snapshot)).toEqual(snapshot.visibleRefs);
    expect(() => service.snapshotVisibleRefs({ ...snapshot, turnId: 42 } as unknown as ReturnType<SkillSnapshotService["createSkillSnapshot"]>)).toThrow(SkillError);
  });

  it("freezeSupportFile：不可变更新返回新快照，幂等重放返回原对象", () => {
    const snapshot = makeSnapshot();
    const refKey = snapshot.visibleRefs[0] ? "ref-1" : "ref-1";
    const entry = {
      skillRefKey: refKey,
      relativePath: "references/guide.md",
      fileHash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sizeBytes: 10,
      frozenAt: nowValue.toISOString(),
    };
    const next = service.freezeSupportFile(snapshot, entry);
    expect(next).not.toBe(snapshot);
    expect(next.snapshotId).toBe(snapshot.snapshotId);
    expect(next.supportFiles).toHaveLength(1);
    expect(snapshot.supportFiles).toHaveLength(0); // 原对象不变
    expect(Object.isFrozen(next.supportFiles[0])).toBe(true);
    // 幂等：同键重放返回同一对象
    expect(service.freezeSupportFile(next, entry)).toBe(next);
  });

  it("shouldRebuild：绑定/版本/信任/readiness/授权变化 → true；支持文件冻结 → false", () => {
    const dir = createSkillPackage(root, { name: "alpha", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    // first：未绑定（P0-5 下 managed 不可见）→ 后续绑定变化触发重建
    const output = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() });
    const first = service.createSkillSnapshot({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1", resolveOutput: output });

    // 相同解析 → 不重建
    const same = service.createSkillSnapshot({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1", resolveOutput: output });
    expect(service.shouldRebuild(first, same)).toBe(false);

    // 绑定变化（pinned）→ 重建
    const pinnedOutput = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [registered.skillRef], environment: makeEnv() });
    const pinnedSnap = service.createSkillSnapshot({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1", resolveOutput: pinnedOutput });
    expect(service.shouldRebuild(first, pinnedSnap)).toBe(true);

    // 版本变化 → 重建
    const dir2 = createSkillPackage(root, { name: "alpha", version: "2.0.0" });
    const v2Registered = ingestPackage(catalog, dir2, "managed", makeEnv());
    const output2 = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [v2Registered.skillRef], environment: makeEnv() });
    const v2 = service.createSkillSnapshot({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1", resolveOutput: output2 });
    expect(service.shouldRebuild(first, v2)).toBe(true);

    // 支持文件首读冻结 → 不重建（同一 turn 内变化）
    const frozen = service.freezeSupportFile(v2, {
      skillRefKey: "k",
      relativePath: "references/a.md",
      fileHash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sizeBytes: 1,
      frozenAt: nowValue.toISOString(),
    });
    expect(service.shouldRebuild(v2, frozen)).toBe(false);

    // 激活授权摘要变化 → 重建
    const withGrant = service.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: output2,
      activationGrants: [
        {
          grantId: "grant-9",
          agentId: "agent-1",
          sessionId: "session-1",
          skillRefKey: `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`,
          contentHash: registered.skillRef.contentHash,
          issuedTurnId: "turn-1",
          expiresAt: "2026-01-02T00:00:00.000Z",
          consumedAt: null,
          reason: "test",
        },
      ],
    });
    expect(service.shouldRebuild(v2, withGrant)).toBe(true);
  });

  it("deepFreeze 冻结嵌套数组元素", () => {
    const nested = deepFreeze({ list: [{ a: 1 }, { b: 2 }] });
    expect(Object.isFrozen(nested.list)).toBe(true);
    expect(Object.isFrozen(nested.list[0])).toBe(true);
    expect(() => {
      (nested.list[0] as unknown as { a: number }).a = 99;
    }).toThrow(TypeError);
  });
});
