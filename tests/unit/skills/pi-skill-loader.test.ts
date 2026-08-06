import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { buildPiSkills, buildPiSkillsFromSnapshot } from "../../../src/pi-sdk/skill-loader.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { SkillSnapshotService } from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { createSkillPackage, ingestPackage, makeEnv, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 PI ResourceLoader 映射单元测试（tests/unit/skills/）
// ═══════════════════════════════════════════════════════════════

describe("buildPiSkills (PI ResourceLoader 接入)", () => {
  let root: string;
  let catalog: SkillCatalog;

  beforeEach(() => {
    root = tmpDir("ocf-pi-loader-");
    catalog = new SkillCatalog();
  });

  afterEach(() => {
    rmrf(root);
  });

  function resolveFor(agentId = "agent-1", pinnedRefs: Parameters<SkillCatalog["listByAgent"]>[0]["pinnedRefs"] = []) {
    return catalog.listByAgent({ agentId, pinnedRefs, environment: makeEnv() });
  }

  it("字段映射：name/description/filePath/baseDir/sourceInfo/disableModelInvocation", () => {
    const dir = createSkillPackage(root, { name: "alpha", description: "Alpha 技能描述", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    // T11（P0-5）：managed 安装默认绑定当前 Agent → 固定引用进入可见集
    const { skills } = buildPiSkills(resolveFor("agent-1", [registered.skillRef]));

    expect(skills).toHaveLength(1);
    const skill = skills[0];
    if (skill === undefined) throw new Error("skills 为空");
    expect(skill.name).toBe("alpha");
    expect(skill.description).toBe("Alpha 技能描述");
    expect(skill.filePath).toBe(path.join(path.resolve(dir), "SKILL.md"));
    expect(skill.baseDir).toBe(path.resolve(dir));
    expect(skill.sourceInfo.path).toBe(skill.filePath);
    expect(skill.sourceInfo.source).toBe(skillRefKey(registered.skillRef));
    expect(skill.sourceInfo.scope).toBe("user"); // managed → user
    expect(skill.sourceInfo.origin).toBe("package");
    expect(skill.sourceInfo.baseDir).toBe(path.resolve(dir));
    expect(skill.disableModelInvocation).toBe(false);
  });

  it("workspace 来源 → scope=project；filePath 只暴露 bundle 内路径", () => {
    const dir = createSkillPackage(root, { name: "ws-skill", description: "workspace skill", version: "1.0.0" });
    ingestPackage(catalog, dir, "workspace", makeEnv());
    const { skills } = buildPiSkills(resolveFor());
    const skill = skills[0];
    if (skill === undefined) throw new Error("skills 为空");
    expect(skill.sourceInfo.scope).toBe("project");
    // filePath 必须位于 rootPath（bundle）内
    expect(skill.filePath.startsWith(skill.baseDir)).toBe(true);
    expect(skill.filePath).not.toContain("..");
  });

  it("disableModelInvocation 从 manifest 透传", () => {
    const dir = createSkillPackage(root, {
      name: "dmi",
      description: "dmi skill",
      version: "1.0.0",
      extraFrontmatter: "disable-model-invocation: true",
    });
    const dmiRegistered = ingestPackage(catalog, dir, "managed", makeEnv());
    const { skills } = buildPiSkills(resolveFor("agent-1", [dmiRegistered.skillRef]));
    expect(skills[0]?.disableModelInvocation).toBe(true);
  });

  it("元数据预算：超限截断 description 并标记 truncated（pinned 优先）", () => {
    const dirA = createSkillPackage(root, { name: "aaa", description: "x".repeat(300), version: "1.0.0" });
    const dirB = createSkillPackage(root, { name: "bbb", description: "y".repeat(300), version: "1.0.0" });
    const pinned = ingestPackage(catalog, dirA, "managed", makeEnv());
    ingestPackage(catalog, dirB, "managed", makeEnv());
    const output = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [pinned.skillRef], environment: makeEnv() });

    const { skills, truncated } = buildPiSkills(output, { maxMetadataChars: 100 });
    expect(truncated).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0]?.name).toBe("aaa"); // pinned 优先
    const totalChars = skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length, 0);
    expect(totalChars).toBeLessThanOrEqual(100 + skills.length);
  });

  it("条目上限：maxSkills 截断", () => {
    const refs = [];
    for (let index = 0; index < 3; index += 1) {
      const dir = createSkillPackage(root, { name: `skill-${index}`, version: "1.0.0" });
      const registered = ingestPackage(catalog, dir, "managed", makeEnv());
      refs.push(registered.skillRef);
    }
    const { skills, truncated } = buildPiSkills(resolveFor("agent-1", refs), { maxSkills: 2 });
    expect(skills).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("诊断映射：解析诊断进入 ResourceDiagnostic（错误类型）", () => {
    // 不存在的 pinned ref → skill_unknown_skillref 诊断
    const phantom: Parameters<SkillCatalog["listByAgent"]>[0]["pinnedRefs"][number] = {
      skillId: "ghost",
      sourceId: "src-ghost",
      sourceKind: "managed",
      version: "1.0.0",
      contentHash: "sha256-ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    };
    const { diagnostics } = buildPiSkills(resolveFor("agent-1", [phantom]));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((diag) => diag.type === "error" && diag.message.includes("ghost"))).toBe(true);
  });

  it("buildPiSkillsFromSnapshot：快照冻结视图映射（与 resolve 输出一致）", () => {
    const dir = createSkillPackage(root, { name: "snap-skill", description: "来自快照", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const snapshots = new SkillSnapshotService();
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: resolveFor("agent-1", [registered.skillRef]),
    });
    const { skills } = buildPiSkillsFromSnapshot(snapshot);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("snap-skill");
    expect(skills[0]?.description).toBe("来自快照");
    expect(skills[0]?.sourceInfo.source).toBe(skillRefKey(registered.skillRef));
    expect(skills[0]?.disableModelInvocation).toBe(false);
  });
});
