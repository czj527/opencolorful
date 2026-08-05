import fs from "node:fs";

import { describe, expect, it } from "vitest";

import type { SkillRef, SkillSelectionMode } from "../../../src/contracts/skill-protocol.js";
import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { resolveSkillCandidates, SKILL_SOURCE_PRECEDENCE } from "../../../src/runtime/skills/resolver.js";
import { createSkillPackage, ingestPackage, makeEnv, makeSkillPackageAt, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Resolver 测试（plans/phase-13.md §8.2 / §18.2）
// - 优先级：workspace > managed > plugin > external > builtin；
// - 同名候选全部保留 + shadowed；固定 SkillRef 优先；Workspace 不替换固定引用；
// - 失效/缺失固定引用不静默回退（fail-closed）；
// - readiness 门控与 selection 覆盖。
// ═══════════════════════════════════════════════════════════════

const env = makeEnv();

function registerSameName(catalog: SkillCatalog, name: string, sourceKind: "workspace" | "managed" | "plugin" | "external" | "builtin", root: string): ReturnType<SkillCatalog["ingestCandidate"]> {
  // 同一显示名、不同来源 → 必须用不同包目录（否则 refKey 冲突会互相替换）
  const packageRoot = makeSkillPackageAt(root, `${sourceKind}/${name}`, { name, version: "1.0.0" });
  return ingestPackage(catalog, packageRoot, sourceKind, env);
}

describe("解析优先级与 shadowed", () => {
  it("默认优先级 workspace > managed > plugin > external > builtin", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const workspace = registerSameName(catalog, "git-workflow", "workspace", root);
    const managed = registerSameName(catalog, "git-workflow", "managed", root);
    const plugin = registerSameName(catalog, "git-workflow", "plugin", root);
    const external = registerSameName(catalog, "git-workflow", "external", root);
    const builtin = registerSameName(catalog, "git-workflow", "builtin", root);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], environment: env });

    expect(output.visible).toHaveLength(1);
    expect(output.visible[0]?.skillRef.sourceKind).toBe("workspace");
    expect(output.shadowed.map((skill) => skill.skillRef.sourceKind).sort()).toEqual(["builtin", "external", "managed", "plugin"]);
    // 同名候选在 Catalog 中全部保留
    expect(catalog.list({ validity: "valid" })).toHaveLength(5);

    const precedence = [workspace.sourceKind, managed.sourceKind, plugin.sourceKind, external.sourceKind, builtin.sourceKind].map(
      (kind) => SKILL_SOURCE_PRECEDENCE[kind],
    );
    expect(precedence).toEqual([...precedence].sort((a, b) => a - b));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同来源多版本：新版本胜出，旧版本 shadowed", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const v1 = makeSkillPackageAt(root, "managed/v1", { name: "git-workflow", version: "1.0.0" });
    const v2 = makeSkillPackageAt(root, "managed/v2", { name: "git-workflow", version: "2.0.0" });
    ingestPackage(catalog, v1, "managed", env);
    ingestPackage(catalog, v2, "managed", env);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], environment: env });
    expect(output.visible).toHaveLength(1);
    expect(output.visible[0]?.skillRef.version).toBe("2.0.0");
    expect(output.shadowed).toHaveLength(1);
    expect(output.shadowed[0]?.skillRef.version).toBe("1.0.0");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("固定 SkillRef 优先", () => {
  it("已固定引用始终使用该版本和哈希，其余同名项 shadowed（含 workspace）", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const workspace = registerSameName(catalog, "git-workflow", "workspace", root);
    const managed = registerSameName(catalog, "git-workflow", "managed", root);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [managed.skillRef], environment: env });
    expect(output.visible).toHaveLength(1);
    expect(output.visible[0]?.skillRef.contentHash).toBe(managed.skillRef.contentHash);
    expect(output.visible[0]?.pinned).toBe(true);
    // workspace 同名不能替换固定引用 → shadowed
    expect(output.shadowed.map((skill) => skill.skillRef.sourceKind)).toContain("workspace");
    expect(output.shadowed.map((skill) => skill.skillRef.sourceKind)).toContain(workspace.sourceKind);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("固定引用缺失 → 诊断，不静默回退到同名 Skill（fail-closed）", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    registerSameName(catalog, "git-workflow", "managed", root);
    const phantomRef: SkillRef = {
      skillId: "git-workflow",
      sourceId: "/tmp/phantom",
      sourceKind: "managed",
      version: "9.9.9",
      contentHash: "sha256-phantom",
    };
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [phantomRef], environment: env });
    expect(output.visible).toHaveLength(0);
    expect(output.diagnostics.some((diagnostic) => diagnostic.code === "skill_unknown_skillref")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("固定引用 readiness 不满足 → gated + 诊断，不回退", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const packageRoot = createSkillPackage(root, {
      name: "needs-gh",
      extraFrontmatter: "metadata:\n  opencolorful:\n    version: 1\n    requires:\n      bins: [git, gh]",
    });
    const registered = ingestPackage(catalog, packageRoot, "managed", env);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [registered.skillRef], environment: env });
    expect(output.visible).toHaveLength(0);
    expect(output.gated).toHaveLength(1);
    expect(output.diagnostics.some((diagnostic) => diagnostic.code === "skill_readiness_blocked")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readiness 门控：blocked/incompatible 不入可见集（普通候选同样适用）", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const packageRoot = createSkillPackage(root, {
      name: "os-bound",
      extraFrontmatter: "metadata:\n  opencolorful:\n    version: 1\n    requires:\n      os: [darwin]",
    });
    ingestPackage(catalog, packageRoot, "managed", env);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], environment: env });
    expect(output.visible).toHaveLength(0);
    expect(output.gated).toHaveLength(1);
    expect(output.gated[0]?.status.readiness).toBe("incompatible");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("degraded 仍可见（env 缺失只是降级）", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const packageRoot = createSkillPackage(root, {
      name: "env-warn",
      extraFrontmatter: "metadata:\n  opencolorful:\n    version: 1\n    requires:\n      env: [MISSING_VAR]",
    });
    ingestPackage(catalog, packageRoot, "managed", env);
    const output = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], environment: env });
    expect(output.visible).toHaveLength(1);
    expect(output.visible[0]?.status.readiness).toBe("degraded");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("selection 覆盖与显式选择", () => {
  it("Agent 级 selectionOverrides：disabled 不入可见集，explicit-only 使低优先级胜出", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const managed = registerSameName(catalog, "git-workflow", "managed", root);
    const builtin = registerSameName(catalog, "git-workflow", "builtin", root);

    // 覆盖 builtin 为 explicit-only → 低优先级显式选择胜出
    const overrides: Record<string, SkillSelectionMode> = {
      [skillRefKey(builtin.skillRef)]: "explicit-only",
    };
    const explicitOutput = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], selectionOverrides: overrides, environment: env });
    expect(explicitOutput.visible).toHaveLength(1);
    expect(explicitOutput.visible[0]?.skillRef.sourceKind).toBe("builtin");
    expect(explicitOutput.shadowed.map((skill) => skill.skillRef.sourceKind)).toContain("managed");

    // 覆盖 managed 为 disabled → 不入可见集
    const disabledOverrides: Record<string, SkillSelectionMode> = {
      [skillRefKey(managed.skillRef)]: "disabled",
    };
    const disabledOutput = resolveSkillCandidates({ candidates: catalog.list(), pinnedRefs: [], selectionOverrides: disabledOverrides, environment: env });
    expect(disabledOutput.disabled.map((skill) => skill.skillRef.sourceKind)).toContain("managed");
    expect(disabledOutput.visible.map((skill) => skill.skillRef.sourceKind)).not.toContain("managed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("listByAgent：把 Agent 固定引用注入 Resolver（T4 入口）", () => {
    const root = tmpDir();
    const catalog = new SkillCatalog();
    const managed = registerSameName(catalog, "git-workflow", "managed", root);
    const output = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [managed.skillRef], environment: env });
    expect(output.visible).toHaveLength(1);
    expect(output.visible[0]?.pinned).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
