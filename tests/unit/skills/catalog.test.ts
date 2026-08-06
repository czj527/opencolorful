import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { createSkillPackage, ingestPackage, makeCandidate, makeEnv, makeInspection, makeSkillPackageAt, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill Catalog 事实模型测试（plans/phase-13.md §9.1 / §18.2）
// ═══════════════════════════════════════════════════════════════

const env = makeEnv();

describe("SkillCatalog 登记与解析", () => {
  it("登记合法候选 → RegisteredSkill（valid/trusted/ready/implicit）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    const registered = ingestPackage(catalog, packageRoot, "managed", env);
    expect(registered.skillRef.skillId).toBe("git-workflow");
    expect(registered.skillRef.sourceKind).toBe("managed");
    expect(registered.skillRef.version).toBe("1.0.0");
    expect(registered.skillRef.contentHash).toMatch(/^sha256-/);
    expect(registered.status.validity).toBe("valid");
    expect(registered.status.trust).toBe("trusted");
    expect(registered.status.readiness).toBe("ready");
    expect(registered.status.selection).toBe("implicit");
    expect(registered.manifest?.name).toBe("git-workflow");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("登记无效候选（validity=invalid）→ selection disabled / readiness incompatible", () => {
    const catalog = new SkillCatalog();
    const registered = catalog.registerCandidate({
      skillId: "broken-skill",
      sourceId: "/tmp/broken",
      sourceKind: "external",
      version: "1.0.0",
      displayName: "broken-skill",
      rootPath: "/tmp/broken",
      contentHash: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
      sizeBytes: 0,
      fileCount: 0,
      manifest: null,
      compatibility: null,
      validity: "invalid",
      validityErrors: ["缺少 SKILL.md"],
      trusted: false,
      environment: env,
    });
    expect(registered.status.validity).toBe("invalid");
    expect(registered.status.selection).toBe("disabled");
    expect(registered.status.readiness).toBe("incompatible");
    expect(registered.status.blockedReason).toBe("skill_manifest_invalid");
  });


  it("findByRefKey：按 skillRefKey 查找（P1-7 Session 临时绑定解析用）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "alpha", version: "1.0.0" });
    const catalog = new SkillCatalog();
    const registered = ingestPackage(catalog, packageRoot, "managed", env);
    const key = skillRefKey(registered.skillRef);

    const found = catalog.findByRefKey(key);
    expect(found).not.toBeUndefined();
    expect(found?.skillRef.contentHash).toBe(registered.skillRef.contentHash);
    // 缺失 → undefined（不抛错，由调用方生成 fail-closed 诊断）
    expect(catalog.findByRefKey("alpha@/nonexistent@1.0.0")).toBeUndefined();
    expect(catalog.findByRefKey("")).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolveBySkillRef 精确匹配；缺失/哈希不符抛错（fail-closed）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    const registered = ingestPackage(catalog, packageRoot, "managed", env);
    expect(catalog.resolveBySkillRef(registered.skillRef).skillId).toBe("git-workflow");
    expect(() => catalog.resolveBySkillRef({ ...registered.skillRef, contentHash: "sha256-wrong" })).toThrow(SkillError);
    expect(() => catalog.resolveBySkillRef({ ...registered.skillRef, version: "9.9.9" })).toThrow(SkillError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("list 支持 sourceKind/validity/readiness/selection 过滤", () => {
    const root = tmpDir();
    const managedRoot = makeSkillPackageAt(root, "managed/git-workflow", { name: "git-workflow", version: "1.0.0" });
    const builtinRoot = makeSkillPackageAt(root, "builtin/git-workflow", { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    ingestPackage(catalog, managedRoot, "managed", env);
    ingestPackage(catalog, builtinRoot, "builtin", env);
    expect(catalog.list({ sourceKind: "managed" })).toHaveLength(1);
    expect(catalog.list({ sourceKind: "builtin" })).toHaveLength(1);
    expect(catalog.list({ validity: "valid" })).toHaveLength(2);
    expect(catalog.list({ readiness: "ready" })).toHaveLength(2);
    expect(catalog.list({ query: "git" })).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同名候选全部保留（冲突不丢弃）", () => {
    const root = tmpDir();
    const managedRoot = makeSkillPackageAt(root, "managed/git-workflow", { name: "git-workflow", version: "1.0.0" });
    const workspaceRoot = makeSkillPackageAt(root, "workspace/git-workflow", { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    ingestPackage(catalog, managedRoot, "managed", env);
    ingestPackage(catalog, workspaceRoot, "workspace", env);
    expect(catalog.list({ validity: "valid" })).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同一 refKey 重复登记 → 替换（刷新语义）", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    const first = ingestPackage(catalog, packageRoot, "managed", env);
    // 修改内容后重新登记同一 ref（skillId/sourceId/version 相同，哈希变化）
    fs.writeFileSync(path.join(packageRoot, "SKILL.md"), "---\nname: git-workflow\ndescription: d\n---\n新的正文\n", "utf8");
    const second = ingestPackage(catalog, packageRoot, "managed", env);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(catalog.list()).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ingestCandidate：哈希不可用 → 抛错（fail-closed）", () => {
    const root = tmpDir();
    const dir = path.join(root, "broken");
    fs.mkdirSync(dir, { recursive: true });
    const inspection = { ...makeInspection(dir), contentHash: "" };
    const catalog = new SkillCatalog();
    expect(() =>
      catalog.ingestCandidate({
        candidate: makeCandidate(dir, "external", "broken"),
        inspection,
        trusted: false,
        environment: env,
      }),
    ).toThrow(SkillError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("selectExactRef：显式选择 → explicit-only；缺失抛错", () => {
    const root = tmpDir();
    const packageRoot = createSkillPackage(root, { name: "git-workflow", version: "1.0.0" });
    const catalog = new SkillCatalog();
    const registered = ingestPackage(catalog, packageRoot, "managed", env);
    const selected = catalog.selectExactRef(registered.skillRef);
    expect(selected.status.selection).toBe("explicit-only");
    expect(catalog.resolveBySkillRef(registered.skillRef).status.selection).toBe("explicit-only");
    expect(() => catalog.selectExactRef({ ...registered.skillRef, version: "9.9.9" })).toThrow(SkillError);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
